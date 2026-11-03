import { createPublicClient, createWalletClient, http, zeroAddress, parseEther, formatEther } from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { readFileSync, writeFileSync, mkdirSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomFillSync } from "node:crypto";
import { CHAINS, DEFAULT_CHAIN_NAMES, resolveChain } from "./chains.mjs";
import { drainerLabel } from "./drainers.mjs";
import { knownGoodLabel } from "./known-good.mjs";

// SATU target yang tidak akan pernah berubah untuk sign-revoke: alamat nol.
// Pencabutan selalu ke sini; pemasangan (sign-auth) adalah perintah terpisah
// dengan pagar registri sendiri (lihat signAuth di bawah).
export const REVOKE_TARGET = zeroAddress;

export function keyFromFile(path) {
  const m = readFileSync(path, "utf8").match(/0x[0-9a-fA-F]{64}/);
  if (!m) throw new Error(`private key tidak ditemukan di berkas ${path}`);
  return m[0];
}

export function publicClient(info) {
  return createPublicClient({ chain: info.chain, transport: http(info.rpc, { timeout: 15_000 }) });
}

export function parseDelegation(code) {
  const hex = (code ?? "0x").toLowerCase();
  if (hex.startsWith("0xef0100") && hex.length === 48) return `0x${hex.slice(8)}`;
  return null;
}

// Diagnosis satu alamat di banyak chain (read-only, tanpa kunci).
export async function checkAddress(address, chainNames = DEFAULT_CHAIN_NAMES) {
  const results = await Promise.all(
    chainNames.map(async (name) => {
      const info = resolveChain(name);
      const client = publicClient(info);
      try {
        const [code, balance, nonce] = await Promise.all([
          client.getCode({ address }),
          client.getBalance({ address }),
          client.getTransactionCount({ address }),
        ]);
        const delegate = parseDelegation(code);
        return {
          chain: name,
          chainId: info.chain.id,
          explorer: info.explorer,
          status: "ok",
          delegated: Boolean(delegate),
          delegate,
          drainerLabel: delegate ? drainerLabel(info.chain.id, delegate) : null,
          balance: balance.toString(),
          nonce,
        };
      } catch (e) {
        return { chain: name, chainId: info.chain.id, explorer: info.explorer, status: "error", error: String(e?.message ?? e), delegated: false, delegate: null, drainerLabel: null, balance: "0", nonce: 0 };
      }
    }),
  );
  return { address, checkedAt: new Date().toISOString(), delegatedCount: results.filter((r) => r.delegated).length, results };
}

// Tanda tangani otorisasi pencabutan (off-chain, gratis). Kunci dompet korban
// dibaca dari berkas; otorisasi selalu ke REVOKE_TARGET (alamat nol).
export async function signRevoke({ chainName, walletKey, nonce }) {
  const info = resolveChain(chainName);
  if (!info) throw new Error(`chain tidak dikenal: ${chainName}`);
  const account = privateKeyToAccount(walletKey);
  const relayerClient = createWalletClient({ account, chain: info.chain, transport: http(info.rpc) });
  const auth = await relayerClient.signAuthorization({
    account,
    contractAddress: REVOKE_TARGET,
    ...(nonce != null ? { nonce } : {}),
  });
  return {
    authority: account.address,
    chainId: auth.chainId,
    address: auth.address,
    nonce: auth.nonce,
    r: auth.r,
    s: auth.s,
    yParity: auth.yParity,
  };
}

// Kirim otorisasi bertanda tangan sebagai transaksi tipe-4. Pengirim (relayer)
// membayar gas; authority tidak perlu memegang dana apa pun.
// `data` opsional: calldata yang dipanggil ke authority DALAM transaksi yang
// sama, tepat sesudah otorisasi diproses (dipakai mode pasang+eksekusi batch
// BatchCallDelegationV2). Tanpa `data`, perilaku persis seperti semula:
// panggilan kosong untuk pemasangan/pencabutan murni. `gasLimit` opsional
// menyesuaikan batas gas + preflight untuk muatan yang lebih besar.
export async function submitAuthorization({ chainName, relayerKey, authorization, authority, data = "0x", gasLimit = null }) {
  const info = resolveChain(chainName);
  if (!info) throw new Error(`chain tidak dikenal: ${chainName}`);
  if (Number(authorization.chainId) !== 0 && Number(authorization.chainId) !== info.chain.id) {
    throw new Error(`DITOLAK: chainId otorisasi (${authorization.chainId}) tidak cocok dengan chain tujuan (${info.chain.id}).`);
  }
  // Pagar registri: otorisasi pemasangan menuju kontrak drainer yang dikenal
  // TIDAK PERNAH boleh diantar, dari berkas auth buatan siapa pun.
  const targetLbl = drainerLabel(info.chain.id, authorization.address);
  if (targetLbl) {
    throw new Error(`DITOLAK: target otorisasi adalah kontrak drainer yang dikenal di chain ini — ${targetLbl}. agent-7702 tidak mengantar pemasangan ke drainer.`);
  }
  const relayer = privateKeyToAccount(relayerKey);
  const client = createWalletClient({ account: relayer, chain: info.chain, transport: http(info.rpc) });
  const pub = publicClient(info);
  // Preflight float: relayer adalah penyedia gas — pastikan saldonya cukup  // untuk estimasi kasar satu transaksi pencabutan sebelum mengirim.
  const [balance, gasPrice] = await Promise.all([pub.getBalance({ address: relayer.address }), pub.getGasPrice()]);
  const estimate = gasPrice * (gasLimit ?? 150_000n);
  if (balance < estimate) {
    throw new Error(
      `DITOLAK (preflight): float relayer ${relayer.address} di ${chainName} tidak cukup — saldo ${formatEther(balance)} < estimasi kebutuhan ${formatEther(estimate)}. Isi ulang secukupnya dari kas utama (mis. BAW), jangan lebih.`,
    );
  }
  const cleanAuth = { chainId: authorization.chainId, address: authorization.address, nonce: authorization.nonce, r: authorization.r, s: authorization.s, yParity: authorization.yParity };
  const hash = await client.sendTransaction({
    account: relayer,
    authorizationList: [cleanAuth],
    to: authority,
    data,
    gas: gasLimit ?? 250_000n, // batas eksplisit: estimasi RPC publik untuk tx tipe-4 tidak stabil
  });
  const receipt = await pub.waitForTransactionReceipt({ hash });
  const codeAfter = await pub.getCode({ address: authority });
  const delegateAfter = parseDelegation(codeAfter);
  return {
    txHash: hash,
    status: receipt.status,
    relayer: relayer.address,
    authority,
    codeAfter: codeAfter ?? "0x",
    delegateAfter,
    healed: !delegateAfter && (codeAfter ?? "0x") === "0x",
    installedTo: delegateAfter,
  };
}

// ---------------------------------------------------------------------------
// Model keamanan relayer (disetujui dayu 2026-10-31, "utamakan security"):
//  1) Float mungil — relayer hanya memegang gas untuk beberapa pencabutan;
//     kas utama tinggal di dompet kustodi operator (mis. Binance Agentic
//     Wallet) dan mengisi ulang secukupnya (just-in-time).
//  2) Satu kunci satu tugas — kunci relayer hanya dipakai agent-7702.
//     Pemasangan ke drainer yang dikenal ditolak di lapisan tanda tangan
//     maupun pengantaran (registri bersama).
//  3) Relayer sekali pakai (ephemeral) per misi untuk chain mahal.
//  4) Kunci disimpan di ~/.agent7702/relayers/ (dir 700, berkas 600),
//     tidak pernah dicetak, tidak pernah masuk repo.
// ---------------------------------------------------------------------------

export const RELAYER_DIR = join(homedir(), ".agent7702", "relayers");

// Panduan float per chainId: low = peringatan menipis, cap = batas atas
// yang dianjurkan untuk relayer tetap (dalam satuan koin native).
export const FLOAT_GUIDE = {
  1: { symbol: "ETH", low: "0.002", cap: "0.01" },
  8453: { symbol: "ETH", low: "0.0005", cap: "0.003" },
  56: { symbol: "BNB", low: "0.002", cap: "0.01" },
  42161: { symbol: "ETH", low: "0.0005", cap: "0.003" },
  10: { symbol: "ETH", low: "0.0005", cap: "0.003" },
  137: { symbol: "POL", low: "0.2", cap: "1" },
  11155111: { symbol: "ETH", low: "0.005", cap: "0.05" },
};

export function relayerKeyPath(chainName, stamp) {
  const base = stamp ? `${chainName}-ephemeral-${stamp}` : chainName;
  return join(RELAYER_DIR, `${base}.key`);
}

// Buat relayer baru. Mengembalikan alamat + lokasi berkas — kuncinya sendiri
// HANYA ada di dalam berkas (izin 600), tidak pernah dikembalikan/dicetak.
export function createRelayer({ chainName, ephemeral = false }) {
  const info = resolveChain(chainName);
  if (!info) throw new Error(`chain tidak dikenal: ${chainName}`);
  const stamp = ephemeral ? new Date().toISOString().replace(/[:.]/g, "-") : null;
  const file = relayerKeyPath(info.name, stamp);
  mkdirSync(RELAYER_DIR, { recursive: true, mode: 0o700 });
  const key = generatePrivateKey();
  writeFileSync(file, key + "\n", { mode: 0o600, flag: "wx" });
  return { chain: info.name, chainId: info.chain.id, address: privateKeyToAccount(key).address, file, ephemeral };
}

export async function relayerStatus(chainNames = DEFAULT_CHAIN_NAMES) {
  const out = [];
  for (const name of chainNames) {
    const info = resolveChain(name);
    const file = relayerKeyPath(info.name);
    let key = null;
    try { key = keyFromFile(file); } catch { /* belum ada relayer tetap */ }
    if (!key) { out.push({ chain: info.name, chainId: info.chain.id, exists: false }); continue; }
    const account = privateKeyToAccount(key);
    const client = publicClient(info);
    const [balance, nonce] = await Promise.all([client.getBalance({ address: account.address }), client.getTransactionCount({ address: account.address })]);
    const guide = FLOAT_GUIDE[info.chain.id];
    const b = Number(formatEther(balance));
    const level = !guide ? "ok" : balance === 0n ? "KOSONG" : b < Number(guide.low) ? "MENIPIS" : b > Number(guide.cap) ? "MELEBIHI CAP — sweep kembali" : "ok";
    out.push({ chain: info.name, chainId: info.chain.id, exists: true, address: account.address, balance: balance.toString(), balanceFormatted: formatEther(balance), nonce, symbol: guide?.symbol ?? "", floatCap: guide?.cap ?? null, level });
  }
  return out;
}

// Kembalikan sisa float ke kas utama (mis. alamat BAW), menyisakan cadangan
// untuk membayar gas transfer ini sendiri.
export async function sweepRelayer({ chainName, relayerKey, to }) {
  const info = resolveChain(chainName);
  if (!info) throw new Error(`chain tidak dikenal: ${chainName}`);
  const relayer = privateKeyToAccount(relayerKey);
  const pub = publicClient(info);
  const client = createWalletClient({ account: relayer, chain: info.chain, transport: http(info.rpc) });
  const [balance, gasPrice] = await Promise.all([pub.getBalance({ address: relayer.address }), pub.getGasPrice()]);
  const reserve = gasPrice * 21_000n * 2n;
  if (balance <= reserve) throw new Error(`saldo ${formatEther(balance)} tidak melebihi cadangan gas ${formatEther(reserve)} — tidak ada yang bisa di-sweep`);
  const value = balance - reserve;
  const hash = await client.sendTransaction({ account: relayer, to, value });
  const receipt = await pub.waitForTransactionReceipt({ hash });
  return { txHash: hash, status: receipt.status, from: relayer.address, to, swept: value.toString(), sweptFormatted: formatEther(value) };
}

// Musnahkan berkas kunci relayer sekali pakai: timpa dengan byte acak
// sepanjang berkas aslinya, lalu hapus.
export function burnRelayerFile(file) {
  const size = readFileSync(file).length;
  const junk = Buffer.alloc(size);
  randomFillSync(junk);
  writeFileSync(file, junk, { mode: 0o600 });
  unlinkSync(file);
  return { burned: file };
}

// Label kepercayaan dua arah untuk sebuah alamat target pada sebuah chain.
export function targetLabel(chainId, address) {
  const bad = drainerLabel(chainId, address);
  if (bad) return { kind: "known-drainer", label: bad };
  const good = knownGoodLabel(chainId, address);
  if (good) return { kind: "known-good", label: good };
  return { kind: "unknown", label: null };
}

// Periksa apakah alamat ada di registri drainer chain MANA PUN (untuk
// otorisasi wildcard chainId 0 yang berlaku lintas chain).
export function drainerLabelAnyChain(address) {
  for (const name of DEFAULT_CHAIN_NAMES) {
    const info = resolveChain(name);
    const lbl = drainerLabel(info.chain.id, address);
    if (lbl) return { chain: name, chainId: info.chain.id, label: lbl };
  }
  return null;
}

// Tanda tangani otorisasi PEMASANGAN delegasi ke kontrak pilihan (off-chain).
// Pagar: menolak alamat nol (itu wilayah sign-revoke), menolak target yang
// bukan kontrak di chain terpilih, menolak target drainer yang dikenal
// (untuk wildcard: drainer di chain mana pun). chainId 0 (anyChain) hanya
// bila diminta eksplisit oleh pemanggil.
export async function signAuth({ chainName, walletKey, to, anyChain = false, nonce }) {
  const info = resolveChain(chainName);
  if (!info) throw new Error(`chain tidak dikenal: ${chainName}`);
  if (String(to).toLowerCase() === REVOKE_TARGET) {
    throw new Error("Target alamat nol adalah PENCABUTAN — gunakan sign-revoke untuk itu.");
  }
  const bad = anyChain ? drainerLabelAnyChain(to) : (() => { const l = drainerLabel(info.chain.id, to); return l ? { chain: chainName, chainId: info.chain.id, label: l } : null; })();
  if (bad) {
    throw new Error(`DITOLAK: target adalah kontrak drainer yang dikenal (${bad.label}, ${bad.chain}) — sign-auth tidak menandatangani pemasangan ke drainer.`);
  }
  const pub = publicClient(info);
  const code = await pub.getCode({ address: to });
  if (!code || code === "0x") {
    throw new Error(`DITOLAK: ${to} bukan kontrak di ${chainName} (kode kosong) — target delegasi harus kontrak yang sudah tersebar.`);
  }
  const account = privateKeyToAccount(walletKey);
  const client = createWalletClient({ account, chain: info.chain, transport: http(info.rpc) });
  const auth = await client.signAuthorization({
    account,
    contractAddress: to,
    ...(anyChain ? { chainId: 0 } : {}),
    ...(nonce != null ? { nonce } : {}),
  });
  return {
    authority: account.address,
    chainId: auth.chainId,
    address: auth.address,
    nonce: auth.nonce,
    r: auth.r,
    s: auth.s,
    yParity: auth.yParity,
    target: targetLabel(info.chain.id, to),
    targetCodeBytes: (code.length - 2) / 2,
  };
}
