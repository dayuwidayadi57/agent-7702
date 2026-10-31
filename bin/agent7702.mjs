#!/usr/bin/env node
// agent-7702 — CLI agen untuk otorisasi EIP-7702 (sebelumnya doctor7702).
//
// Dua arah otorisasi, satu alat (keputusan pemilik, 2026-10-31):
//   PENCABUTAN  — sign-revoke / revoke: target dikunci ke alamat nol.
//   PEMASANGAN  — sign-auth / delegate: target kontrak pilihan, BERPAGAR
//                 registri (drainer yang dikenal ditolak di lapisan tanda
//                 tangan maupun pengantaran; target wajib kontrak; chain
//                 eksplisit kecuali --any-chain diminta dengan sadar).
// Semua pengantaran lewat relayer yang membayar gas (model float aman:
// kas di dompet kustodi, float mungil, preflight, sekali pakai, watchdog).
//
// Kunci SELALU dibaca dari berkas (izin 600 dianjurkan), tidak pernah dari
// argumen baris perintah atau chat.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { isAddress } from "viem";
import { checkAddress, signRevoke, signAuth, submitAuthorization, keyFromFile, publicClient, parseDelegation, targetLabel, createRelayer, relayerStatus, sweepRelayer, burnRelayerFile, RELAYER_DIR, FLOAT_GUIDE } from "../lib/core.mjs";
import { getAssets, topup, topupAmountFor, sendToken, sendNft, sendNative, buildIntent, signIntent, executeAtomic, rescueDelegateFor, buildIntentV2, signIntentV2, executeAtomicV2, rescueDelegateV2For, claimCheck } from "../lib/rescue.mjs";
import { resolveChain, DEFAULT_CHAIN_NAMES } from "../lib/chains.mjs";
import { privateKeyToAccount } from "viem/accounts";

// Jurnal misi rescue: catatan aksi yang sudah terkonfirmasi, disimpan di
// samping berkas aset (<assets>.journal.json) dan diperbarui SEGERA sesudah
// tiap pengiriman berhasil — agar misi yang terputus dapat dilanjutkan
// tanpa mengirim ulang aset yang sama.
function saveJournal(path, j) {
  j.updatedAt = new Date().toISOString();
  writeFileSync(path, JSON.stringify(j, null, 2));
}

// Sumber tunggal versi: package.json. Naikkan di sana + catat di CHANGELOG.md.
const VERSION = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

const args = process.argv.slice(2);
const cmd = args[0];
const json = args.includes("--json");

function flag(name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}
function out(obj, human) {
  if (json) console.log(JSON.stringify(obj, null, 2));
  else console.log(human);
}
function die(msg) {
  console.error(json ? JSON.stringify({ error: msg }) : `Error: ${msg}`);
  process.exit(1);
}

const HELP = `   /\\     /\\
__/  \\/\\/\\/  \\____   agent-7702 v${VERSION}
                     EIP-7702 Wallet Doctor — CLI agen untuk otorisasi EIP-7702

  Diagnosis:
  agent7702 check <address> [--chains ethereum,base,bsc,arbitrum,optimism,polygon,sepolia] [--json]

  Pencabutan (target terkunci ke alamat nol):
  agent7702 sign-revoke --chain <chain> --wallet-file <berkas> [--nonce <n>] [--json]
  agent7702 revoke --chain <chain> --wallet-file <berkas> --relayer-file <berkas> [--execute] [--json]

  Pemasangan (target kontrak pilihan, berpagar registri):
  agent7702 sign-auth --chain <chain> --to <kontrak> --wallet-file <berkas> [--any-chain] [--nonce <n>] [--json]
  agent7702 delegate --chain <chain> --to <kontrak> --wallet-file <berkas> --relayer-file <berkas> [--execute] [--json]

  Pengantaran (relayer membayar gas):
  agent7702 submit --chain <chain> --relayer-file <berkas> --auth <berkas-json|-> [--json]

  Relayer (model aman: float mungil, kas di dompet kustodi mis. BAW):
  agent7702 relayer new --chain <chain> [--ephemeral] [--json]
  agent7702 relayer status [--chains a,b,c] [--json]
  agent7702 relayer sweep --chain <chain> --relayer-file <berkas> --to <alamat-kas> [--json]
  agent7702 relayer burn --file <berkas-di-dir-relayer> [--json]

  Penyelamatan aset (dompet yang sudah/akan dibersihkan):
  agent7702 assets <address> --chain <chain> [--token <addr> ...] [--json]
  agent7702 topup --chain <chain> --relayer-file <berkas> --to <dompet-bersih> [--amount <n>] [--json]
  agent7702 send-token --chain <chain> --wallet-file <berkas> --token <addr> --to <tujuan> (--amount <n>|--all) [--execute] [--json]
  agent7702 send-nft --chain <chain> --wallet-file <berkas> --token <addr> --id <n> [--amount <n>] --to <tujuan> [--execute] [--json]
  agent7702 rescue --chain <chain> --wallet-file <berkas> --relayer-file <berkas> --to <aman> --assets <berkas.json> [--execute] [--fresh] [--json]

  Atomic Rescue (panen atomik via RescueDelegate):
  agent7702 sign-intent --chain <chain> --wallet-file <berkas> --to <aman> --assets <berkas.json> [--ttl <menit>] [--json]
  agent7702 execute --chain <chain> --relayer-file <berkas> --auth <berkas> --intent <berkas> [--json]
  agent7702 atomic-rescue --chain <chain> --wallet-file <berkas> --relayer-file <berkas> --to <aman> --assets <berkas.json> [--ttl <menit>] [--execute] [--json]
  agent7702 claim-check <kontrak> --chain <chain> --wallet <dompet> [--allocation <berkas.json>] [--out <berkas.json>] [--json]
  agent7702 claim-rescue --chain <chain> --wallet-file <berkas> --relayer-file <berkas> --to <aman> --assets <berkas.json> [--ttl <menit>] [--execute] [--json]

Pagar: pemasangan ke kontrak drainer yang dikenal DITOLAK (sign maupun
submit); target pemasangan wajib kontrak; kunci selalu dari berkas.`;

function labelLine(t) {
  if (!t) return "";
  if (t.kind === "known-drainer") return ` [DRAINER DIKENAL: ${t.label}]`;
  if (t.kind === "known-good") return ` [dikenal: ${t.label}]`;
  return " [TIDAK DIKENAL — periksa ekstra hati-hati]";
}

async function main() {
  if (cmd === "version" || cmd === "--version" || args.includes("--version")) {
    out({ name: "agent-7702", version: VERSION }, `agent-7702 v${VERSION}`);
    return;
  }
  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
    console.log(HELP);
    return;
  }

  if (cmd === "check") {
    const address = args[1];
    if (!address || !isAddress(address)) die("alamat tidak valid");
    const chains = flag("--chains") ? flag("--chains").split(",").map((s) => s.trim()) : DEFAULT_CHAIN_NAMES;
    const res = await checkAddress(address, chains);
    const human = [
      `Diagnosis ${res.address} — ${res.delegatedCount} chain terdelegasi`,
      ...res.results.map((r) =>
        r.status === "error"
          ? `  ${r.chain.padEnd(10)} GAGAL CEK (${r.error})`
          : r.delegated
            ? `  ${r.chain.padEnd(10)} TERDELEGASI -> ${r.delegate}${r.drainerLabel ? ` [${r.drainerLabel}]` : ""} (nonce ${r.nonce})`
            : `  ${r.chain.padEnd(10)} bersih (nonce ${r.nonce})`,
      ),
    ].join("\n");
    out(res, human);
    process.exit(res.delegatedCount > 0 ? 2 : 0);
  }

  if (cmd === "sign-revoke") {
    const chain = flag("--chain");
    const walletFile = flag("--wallet-file");
    if (!chain || !walletFile) die("wajib: --chain dan --wallet-file");
    const nonce = flag("--nonce") ? Number(flag("--nonce")) : undefined;
    const auth = await signRevoke({ chainName: chain, walletKey: keyFromFile(walletFile), nonce });
    out(auth, `Otorisasi pencabutan ditandatangani:\n${JSON.stringify(auth, null, 2)}\n\nSimpan JSON ini; kirimkan kapan pun dengan: agent7702 submit --chain ${chain} --relayer-file <berkas> --auth <berkas-json>`);
    return;
  }

  if (cmd === "sign-auth") {
    const chain = flag("--chain");
    const to = flag("--to");
    const walletFile = flag("--wallet-file");
    if (!chain || !to || !walletFile) die("wajib: --chain, --to, --wallet-file");
    if (!isAddress(to)) die("--to bukan alamat valid");
    const anyChain = args.includes("--any-chain");
    const nonce = flag("--nonce") ? Number(flag("--nonce")) : undefined;
    const auth = await signAuth({ chainName: chain, walletKey: keyFromFile(walletFile), to, anyChain, nonce });
    const warn = [
      auth.target.kind === "unknown" ? "PERINGATAN: target TIDAK ADA di registri mana pun — pastikan kode kontrak ini memang yang kamu percayai; sekali terpasang, kode inilah yang mengendalikan dompet." : null,
      anyChain ? "PERINGATAN: chainId 0 — otorisasi ini berlaku di SEMUA chain tempat nonce dompet cocok. Memasang di mana pun ia dipakai." : null,
    ].filter(Boolean);
    out(
      auth,
      `Otorisasi PEMASANGAN ditandatangani:\n${JSON.stringify(auth, null, 2)}${warn.length ? `\n\n${warn.join("\n")}` : ""}\n\nKirimkan dengan: agent7702 submit --chain ${chain} --relayer-file <berkas> --auth <berkas-json>`,
    );
    return;
  }

  if (cmd === "submit") {
    const chain = flag("--chain");
    const relayerFile = flag("--relayer-file");
    const authPath = flag("--auth");
    if (!chain || !relayerFile || !authPath) die("wajib: --chain, --relayer-file, --auth");
    const raw = authPath === "-" ? readFileSync(0, "utf8") : readFileSync(authPath, "utf8");
    const parsed = JSON.parse(raw);
    const { authority, ...authorization } = parsed;
    if (!authority) die("berkas otorisasi tidak memuat field authority");
    const res = await submitAuthorization({ chainName: chain, relayerKey: keyFromFile(relayerFile), authorization, authority });
    out(
      res,
      res.healed
        ? `Terkirim: ${res.txHash}\nStatus: ${res.status} | kode sesudah: ${res.codeAfter} | SEMBUH: YA — delegasi tercabut`
        : `Terkirim: ${res.txHash}\nStatus: ${res.status} | kode sesudah: ${res.codeAfter} | TERPASANG ke: ${res.installedTo}`,
    );
    return;
  }

  if (cmd === "revoke") {
    const chain = flag("--chain");
    const walletFile = flag("--wallet-file");
    const relayerFile = flag("--relayer-file");
    if (!chain || !walletFile || !relayerFile) die("wajib: --chain, --wallet-file, --relayer-file");
    const info = resolveChain(chain);
    if (!info) die(`chain tidak dikenal: ${chain}`);
    const walletKey = keyFromFile(walletFile);
    const authority = privateKeyToAccount(walletKey).address;
    const pub = publicClient(info);
    const codeBefore = (await pub.getCode({ address: authority })) ?? "0x";
    const delegateBefore = parseDelegation(codeBefore);
    const auth = await signRevoke({ chainName: chain, walletKey });
    if (!args.includes("--execute")) {
      out(
        { dryRun: true, authority, chain, codeBefore, delegateBefore, authorization: auth },
        `PRATINJAU (dry-run) — tidak ada yang dikirim.\nAuthority : ${authority}\nChain     : ${chain} (${info.chain.id})\nKode awal : ${codeBefore}${delegateBefore ? ` (terdelegasi ke ${delegateBefore})` : ""}\nOtorisasi : chainId ${auth.chainId}, nonce ${auth.nonce}, address ${auth.address} (alamat nol = cabut)\n\nTambahkan --execute untuk mengirim lewat relayer.`,
      );
      return;
    }
    const res = await submitAuthorization({ chainName: chain, relayerKey: keyFromFile(relayerFile), authorization: auth, authority });
    out(
      { ...res, codeBefore, delegateBefore },
      `Terkirim: ${res.txHash}\nKode awal: ${codeBefore} -> kode sesudah: ${res.codeAfter}\nSEMBUH: ${res.healed ? "YA — dompet kembali EOA polos" : "BELUM — periksa lagi"}`,
    );
    return;
  }

  if (cmd === "delegate") {
    const chain = flag("--chain");
    const to = flag("--to");
    const walletFile = flag("--wallet-file");
    const relayerFile = flag("--relayer-file");
    if (!chain || !to || !walletFile || !relayerFile) die("wajib: --chain, --to, --wallet-file, --relayer-file");
    if (!isAddress(to)) die("--to bukan alamat valid");
    const info = resolveChain(chain);
    if (!info) die(`chain tidak dikenal: ${chain}`);
    const walletKey = keyFromFile(walletFile);
    const authority = privateKeyToAccount(walletKey).address;
    const pub = publicClient(info);
    const codeBefore = (await pub.getCode({ address: authority })) ?? "0x";
    const auth = await signAuth({ chainName: chain, walletKey, to, anyChain: args.includes("--any-chain") });
    const t = targetLabel(info.chain.id, to);
    if (!args.includes("--execute")) {
      out(
        { dryRun: true, authority, chain, codeBefore, target: { address: to, ...t }, authorization: auth },
        `PRATINJAU PEMASANGAN (dry-run) — tidak ada yang dikirim.\nAuthority : ${authority}\nChain     : ${chain} (${info.chain.id})\nKode awal : ${codeBefore}\nTarget    : ${to}${labelLine(t)}\nOtorisasi : chainId ${auth.chainId}, nonce ${auth.nonce}, address ${auth.address}\n\nSekali terpasang, kode target MENGENDALIKAN dompet ini. Tambahkan --execute hanya bila target ini memang kamu percayai.`,
      );
      return;
    }
    const res = await submitAuthorization({ chainName: chain, relayerKey: keyFromFile(relayerFile), authorization: auth, authority });
    const ok = (res.installedTo ?? "").toLowerCase() === to.toLowerCase();
    out(
      { ...res, codeBefore, target: { address: to, ...t } },
      `Terkirim: ${res.txHash}\nKode awal: ${codeBefore} -> kode sesudah: ${res.codeAfter}\nTERPASANG: ${ok ? `YA — terdelegasi ke ${to}` : "BELUM — periksa lagi"}`,
    );
    return;
  }

  if (cmd === "assets") {
    const address = args[1];
    const chain = flag("--chain");
    if (!address || !isAddress(address) || !chain) die("wajib: <address> dan --chain");
    const extraTokens = [];
    for (let i = 0; i < args.length; i++) if (args[i] === "--token" && args[i + 1]) extraTokens.push(args[i + 1]);
    const res = await getAssets(chain, address, extraTokens);
    const human = [
      `Inventaris ${address} @ ${chain} (sumber: ${res.source})${res.delegatedTo ? ` — MASIH TERDELEGASI ke ${res.delegatedTo}` : ""}`,
      `  native : ${res.native} wei`,
      ...res.tokens.map((t) => `  ERC20  : ${t.symbol ?? "?"} ${t.address} saldo mentah ${t.balance}`),
      ...res.nfts.map((n) => `  NFT    : ${n.symbol ?? "?"} ${n.address} (${n.standard}) id ${n.tokenId}${n.balance ? ` x${n.balance}` : ""}`),
      ...(res.warning ? [`  catatan: ${res.warning}`] : []),
    ].join("\n");
    out(res, human);
    return;
  }

  if (cmd === "topup") {
    const chain = flag("--chain");
    const relayerFile = flag("--relayer-file");
    const to = flag("--to");
    if (!chain || !relayerFile || !to || !isAddress(to)) die("wajib: --chain, --relayer-file, --to <alamat valid>");
    const res = await topup({ chainName: chain, relayerKey: keyFromFile(relayerFile), to, amount: flag("--amount") });
    out(res, `Topup terkirim: ${res.txHash}\n${res.amount} wei dari relayer ${res.from} ke ${res.to} (status ${res.status})`);
    return;
  }

  if (cmd === "send-token") {
    const chain = flag("--chain");
    const walletFile = flag("--wallet-file");
    const token = flag("--token");
    const to = flag("--to");
    if (!chain || !walletFile || !token || !to) die("wajib: --chain, --wallet-file, --token, --to");
    const amount = args.includes("--all") ? "all" : flag("--amount");
    if (!amount) die("wajib: --amount <n> atau --all");
    if (!args.includes("--execute")) {
      out({ dryRun: true, chain, token, to, amount }, `PRATINJAU (dry-run): kirim ERC20 ${token} sebesar ${amount} ke ${to} di ${chain}, ditandatangani pemilik dompet. Tambahkan --execute untuk mengirim.`);
      return;
    }
    const res = await sendToken({ chainName: chain, walletKey: keyFromFile(walletFile), token, to, amount });
    out(res, `Terkirim: ${res.txHash}\n${res.amountFormatted} ${res.symbol} dari ${res.from} ke ${res.to} (status ${res.status})`);
    return;
  }

  if (cmd === "send-nft") {
    const chain = flag("--chain");
    const walletFile = flag("--wallet-file");
    const token = flag("--token");
    const id = flag("--id");
    const to = flag("--to");
    if (!chain || !walletFile || !token || id == null || !to) die("wajib: --chain, --wallet-file, --token, --id, --to");
    if (!args.includes("--execute")) {
      out({ dryRun: true, chain, token, id, to }, `PRATINJAU (dry-run): kirim NFT ${token} id ${id} ke ${to} di ${chain}, ditandatangani pemilik dompet. Tambahkan --execute untuk mengirim.`);
      return;
    }
    const res = await sendNft({ chainName: chain, walletKey: keyFromFile(walletFile), token, id, to, amount: flag("--amount") });
    out(res, `Terkirim: ${res.txHash}\nNFT ${res.standard} ${res.token} id ${res.id} dari ${res.from} ke ${res.to} (status ${res.status})`);
    return;
  }

  if (cmd === "sign-intent") {
    const chain = flag("--chain");
    const walletFile = flag("--wallet-file");
    const to = flag("--to");
    const assetsFile = flag("--assets");
    if (!chain || !walletFile || !to || !assetsFile) die("wajib: --chain, --wallet-file, --to, --assets");
    const spec = JSON.parse(readFileSync(assetsFile, "utf8"));
    const info = resolveChain(chain);
    if (!info) die(`chain tidak dikenal: ${chain}`);
    const intent = buildIntent({ chainId: info.chain.id, to, actions: spec.actions ?? [], ttlMinutes: flag("--ttl") ? Number(flag("--ttl")) : 15 });
    const signed = await signIntent({ chainName: chain, walletKey: keyFromFile(walletFile), intent });
    out(signed, `Intent penyelamatan ditandatangani:\n${JSON.stringify(signed, null, 2)}\n\nSimpan JSON ini; jalankan atomik dengan: agent7702 execute --chain ${chain} --relayer-file <berkas> --auth <berkas-sign-auth> --intent <berkas-ini>`);
    return;
  }

  if (cmd === "execute") {
    const chain = flag("--chain");
    const relayerFile = flag("--relayer-file");
    const authPath = flag("--auth");
    const intentPath = flag("--intent");
    if (!chain || !relayerFile || !authPath || !intentPath) die("wajib: --chain, --relayer-file, --auth, --intent");
    const authParsed = JSON.parse(readFileSync(authPath, "utf8"));
    const { authority, ...authorization } = authParsed;
    const intentSigned = JSON.parse(readFileSync(intentPath, "utf8"));
    if (authority && intentSigned.wallet && authority.toLowerCase() !== intentSigned.wallet.toLowerCase()) die("authority pada berkas auth tidak cocok dengan wallet pada intent");
    const res = await executeAtomic({ chainName: chain, relayerKey: keyFromFile(relayerFile), authorization, intentSigned });
    out(res, `TX ATOMIK terkirim: ${res.txHash}\nStatus: ${res.status} | dompet kini terdelegasi ke: ${res.delegatedTo} (RescueDelegate — tutup misi dengan revoke)`);
    return;
  }

  if (cmd === "claim-check") {
    const contract = args[1];
    const chain = flag("--chain");
    const wallet = flag("--wallet");
    if (!contract || !chain || !wallet) die("wajib: claim-check <kontrak> --chain <chain> --wallet <dompet> [--allocation <berkas>] [--out <berkas>]");
    const allocation = flag("--allocation") ? JSON.parse(readFileSync(flag("--allocation"), "utf8")) : null;
    const res = await claimCheck({ chainName: chain, contract, wallet, allocation });
    let outNote = "";
    if (flag("--out")) {
      if (res.action) { writeFileSync(flag("--out"), JSON.stringify({ actions: [res.action] }, null, 2)); outNote = `\nBerkas aset claim ditulis ke ${flag("--out")}`; }
      else outNote = "\n(--out dilewati: belum ada aksi claim yang terverifikasi)";
    }
    const lines = [
      `CLAIM-CHECK ${contract} di ${chain}${res.contractName ? ` (${res.contractName}${res.verified ? ", terverifikasi" : ""})` : ""}`,
      `Dompet      : ${wallet}`,
      `Token hadiah: ${res.token ? `${res.tokenSymbol} ${res.token}` : "tidak terbaca"}`,
      `Fungsi claim: ${res.claimFunctions.length ? res.claimFunctions.join(" ; ") : "tidak ditemukan"}`,
      `Sudah diklaim: ${res.alreadyClaimed === null ? "tidak terbaca" : res.alreadyClaimed ? "YA" : "belum"}`,
      `Alokasi terverifikasi simulasi: ${res.allocationVerified === null ? "tidak diuji (tanpa --allocation)" : res.allocationVerified ? "LOLOS" : "GAGAL"}`,
      ...(res.action ? [`Aksi siap pakai: ${res.action.note}`] : []),
      ...res.warnings.map((w) => `PERINGATAN: ${w}`),
    ].join("\n");
    out(res, lines + outNote);
    return;
  }

  if (cmd === "claim-rescue") {
    const chain = flag("--chain");
    const walletFile = flag("--wallet-file");
    const relayerFile = flag("--relayer-file");
    const to = flag("--to");
    const assetsFile = flag("--assets");
    if (!chain || !walletFile || !relayerFile || !to || !assetsFile) die("wajib: --chain, --wallet-file, --relayer-file, --to, --assets");
    const info = resolveChain(chain);
    if (!info) die(`chain tidak dikenal: ${chain}`);
    const rd = rescueDelegateV2For(info.chain.id);
    if (!rd) die(`RescueDelegateV2 belum tersedia di ${chain}`);
    const walletKey = keyFromFile(walletFile);
    const relayerKey = keyFromFile(relayerFile);
    const authority = privateKeyToAccount(walletKey).address;
    const pub = publicClient(info);
    const codeNow = (await pub.getCode({ address: authority })) ?? "0x";
    const execute = args.includes("--execute");
    const spec = JSON.parse(readFileSync(assetsFile, "utf8"));
    const specActions = spec.actions ?? [];
    const auth = await signAuth({ chainName: chain, walletKey, to: rd });
    const intent = buildIntentV2({ chainId: info.chain.id, to, actions: specActions, ttlMinutes: flag("--ttl") ? Number(flag("--ttl")) : 15 });
    const signed = await signIntentV2({ chainName: chain, walletKey, intent });
    const describe = specActions.map((a, i) => a.kind === 4 ? `  [${i}] CLAIM -> ${a.token} dari ${a.claim?.contract} (${a.note ?? "tanpa catatan"})` : `  [${i}] kind ${a.kind} token ${a.token} amount ${a.amount ?? "0"}`).join("\n");
    if (!execute) {
      out({ dryRun: true, authority, chain, rescueDelegateV2: rd, intent: signed }, `PRATINJAU CLAIM RESCUE (dry-run) — tidak ada yang dikirim.\nDompet    : ${authority} (kode kini: ${codeNow})\nDelegate  : RescueDelegateV2 ${rd}\nTujuan    : ${to}\nIntent    : ${signed.actions.length} aksi, kedaluwarsa ${signed.expiry}\n${describe}\nRencana   : 1 tx atomik v2 (pasang + claim/panen) lalu 1 tx revoke penutup.\n\nTambahkan --execute untuk menjalankan misi.`);
      return;
    }
    const { authority: _a, ...authorization } = auth;
    const atomic = await executeAtomicV2({ chainName: chain, relayerKey, authorization, intentSigned: signed });
    const revokeAuth = await signRevoke({ chainName: chain, walletKey });
    const closed = await submitAuthorization({ chainName: chain, relayerKey, authorization: revokeAuth, authority });
    const claimAction = specActions.find((a) => a.kind === 4 && a.token && a.token !== "0x0000000000000000000000000000000000000000");
    let destBalance = null;
    if (claimAction) {
      const da = await getAssets(chain, to, [claimAction.token]);
      destBalance = da.tokens.find((t) => t.address.toLowerCase() === claimAction.token.toLowerCase())?.balance ?? "0";
    }
    out({ atomic, closing: closed, destinationClaimTokenBalance: destBalance }, `CLAIM RESCUE selesai.\nTx atomik : ${atomic.txHash} (status ${atomic.status})\nTx penutup: ${closed.txHash} | kode akhir: ${closed.codeAfter} | BERSIH: ${closed.healed ? "YA" : "BELUM — periksa"}${destBalance !== null ? `\nSaldo token claim di tujuan: ${destBalance}` : ""}`);
    return;
  }

  if (cmd === "rescue" || cmd === "atomic-rescue") {
    const chain = flag("--chain");
    const walletFile = flag("--wallet-file");
    const relayerFile = flag("--relayer-file");
    const to = flag("--to");
    const assetsFile = flag("--assets");
    if (!chain || !walletFile || !relayerFile || !to || (cmd === "atomic-rescue" && !assetsFile)) die("wajib: --chain, --wallet-file, --relayer-file, --to" + (cmd === "atomic-rescue" ? ", --assets" : ""));
    const info = resolveChain(chain);
    if (!info) die(`chain tidak dikenal: ${chain}`);
    const walletKey = keyFromFile(walletFile);
    const relayerKey = keyFromFile(relayerFile);
    const authority = privateKeyToAccount(walletKey).address;
    const pub = publicClient(info);
    const codeNow = (await pub.getCode({ address: authority })) ?? "0x";
    const execute = args.includes("--execute");

    if (cmd === "atomic-rescue") {
      const rd = rescueDelegateFor(info.chain.id);
      if (!rd) die(`RescueDelegate belum tersedia di ${chain}`);
      const spec = JSON.parse(readFileSync(assetsFile, "utf8"));
      const auth = await signAuth({ chainName: chain, walletKey, to: rd });
      const intent = buildIntent({ chainId: info.chain.id, to, actions: spec.actions ?? [], ttlMinutes: flag("--ttl") ? Number(flag("--ttl")) : 15 });
      const signed = await signIntent({ chainName: chain, walletKey, intent });
      if (!execute) {
        out({ dryRun: true, authority, chain, rescueDelegate: rd, authorization: auth, intent: signed }, `PRATINJAU ATOMIC RESCUE (dry-run) — tidak ada yang dikirim.\nDompet    : ${authority} (kode kini: ${codeNow})\nDelegate  : RescueDelegate ${rd}\nIntent    : ${signed.actions.length} aksi -> ${to}, kedaluwarsa ${signed.expiry}\nRencana   : 1 tx atomik (pasang + panen) lalu 1 tx revoke penutup.\n\nTambahkan --execute untuk menjalankan misi.`);
        return;
      }
      const { authority: _a, ...authorization } = auth;
      const atomic = await executeAtomic({ chainName: chain, relayerKey, authorization, intentSigned: signed });
      const revokeAuth = await signRevoke({ chainName: chain, walletKey });
      const closed = await submitAuthorization({ chainName: chain, relayerKey, authorization: revokeAuth, authority });
      out({ atomic, closing: closed }, `ATOMIC RESCUE selesai.\nTx atomik : ${atomic.txHash} (status ${atomic.status})\nTx penutup: ${closed.txHash} | kode akhir: ${closed.codeAfter} | BERSIH: ${closed.healed ? "YA" : "BELUM — periksa"}`);
      return;
    }

    // rescue (Jalur A): cabut -> topup -> pindahkan aset dari berkas -> verifikasi
    const spec = assetsFile ? JSON.parse(readFileSync(assetsFile, "utf8")) : { actions: [] };
    const actions = spec.actions ?? [];
    if (!execute) {
      let journalDone = 0;
      if (assetsFile && existsSync(`${assetsFile}.journal.json`)) {
        try { journalDone = Object.keys(JSON.parse(readFileSync(`${assetsFile}.journal.json`, "utf8")).done ?? {}).length; } catch { journalDone = 0; }
      }
      out({ dryRun: true, authority, chain, codeNow, actions, journalDone }, `PRATINJAU RESCUE Jalur A (dry-run) — tidak ada yang dikirim.\nDompet: ${authority} (kode kini: ${codeNow})\nRencana: ${codeNow !== "0x" ? "revoke -> " : ""}topup -> pindahkan ${actions.length} aset ke ${to} -> verifikasi.${journalDone ? `\nJurnal misi: ${journalDone} aksi sudah selesai dan akan dilewati.` : ""}\n\nTambahkan --execute untuk menjalankan.`);
      return;
    }
    const steps = [];
    const journalPath = assetsFile ? `${assetsFile}.journal.json` : null;
    let journal = null;
    if (journalPath && !args.includes("--fresh") && existsSync(journalPath)) {
      journal = JSON.parse(readFileSync(journalPath, "utf8"));
      if (journal.chainId !== info.chain.id || journal.wallet.toLowerCase() !== authority.toLowerCase() || journal.to.toLowerCase() !== to.toLowerCase()) die(`jurnal misi ${journalPath} tidak cocok dengan misi ini (chain/dompet/tujuan berbeda) — hapus berkas jurnal itu atau jalankan dengan --fresh`);
      journal.done = journal.done ?? {};
    }
    if (journalPath && !journal) {
      journal = { version: 1, chainId: info.chain.id, chain, wallet: authority, to, done: {}, swept: null, createdAt: new Date().toISOString() };
      saveJournal(journalPath, journal);
    }
    if (codeNow !== "0x") {
      const ra = await signRevoke({ chainName: chain, walletKey });
      const r = await submitAuthorization({ chainName: chain, relayerKey, authorization: ra, authority });
      steps.push({ step: "revoke", txHash: r.txHash, healed: r.healed });
      if (!r.healed) die("revoke gagal menyembuhkan — misi dihentikan sebelum topup");
    }
    const walletBal = await pub.getBalance({ address: authority });
    if (walletBal >= topupAmountFor(chain) / 4n) {
      steps.push({ step: "topup", skipped: true, reason: "dompet sudah memegang cukup native", balance: walletBal.toString() });
    } else {
      const tp = await topup({ chainName: chain, relayerKey, to: authority });
      steps.push({ step: "topup", txHash: tp.txHash, amount: tp.amount });
    }
    for (let i = 0; i < actions.length; i++) {
      const a = actions[i];
      if (a.kind === 0) continue; // native ditangani terakhir sebagai sapuan menyeluruh
      const kindName = a.kind === 1 ? "send-token" : "send-nft";
      if (journal && journal.done[String(i)]) {
        steps.push({ step: kindName, skipped: true, reason: "sudah selesai menurut jurnal misi", txHash: journal.done[String(i)].txHash });
        continue;
      }
      const res = a.kind === 1
        ? await sendToken({ chainName: chain, walletKey, token: a.token, to, rawAmount: String(a.amount) })
        : a.kind === 2
          ? await sendNft({ chainName: chain, walletKey, token: a.token, id: String(a.tokenId), to })
          : await sendNft({ chainName: chain, walletKey, token: a.token, id: String(a.tokenId), to, amount: String(a.amount) });
      steps.push({ step: kindName, ...res });
      if (journal) { journal.done[String(i)] = { txHash: res.txHash, at: new Date().toISOString() }; saveJournal(journalPath, journal); }
    }
    const nativeAction = actions.find((a) => a.kind === 0);
    if (nativeAction) {
      if (journal && journal.swept) {
        steps.push({ step: "send-native", skipped: true, reason: "sudah disapu menurut jurnal misi", txHash: journal.swept.txHash });
      } else {
        const res = await sendNative({ chainName: chain, walletKey, to, amount: "all" });
        steps.push({ step: "send-native", ...res });
        if (journal) { journal.swept = { txHash: res.txHash, at: new Date().toISOString() }; saveJournal(journalPath, journal); }
      }
    }
    const finalCheck = await checkAddress(authority, [chain]);
    out({ authority, chain, to, steps, finalDelegatedCount: finalCheck.delegatedCount }, `RESCUE Jalur A selesai — ${steps.length} langkah terkirim, delegasi akhir: ${finalCheck.delegatedCount} chain. Tujuan: ${to}`);
    return;
  }

  if (cmd === "relayer") {
    const sub = args[1];
    if (sub === "new") {
      const chain = flag("--chain");
      if (!chain) die("wajib: --chain");
      const r = createRelayer({ chainName: chain, ephemeral: args.includes("--ephemeral") });
      const guide = FLOAT_GUIDE[r.chainId];
      out(
        r,
        `Relayer ${r.ephemeral ? "sekali pakai" : "tetap"} dibuat untuk ${r.chain}:\nAlamat : ${r.address}\nBerkas : ${r.file} (izin 600, jangan dibagikan)\n\nIsi float SECUKUPNYA dari kas utama (mis. BAW) — anjuran maks ${guide ? `${guide.cap} ${guide.symbol}` : "?"} untuk relayer tetap; untuk sekali pakai isi pas estimasi misi lalu sweep + burn sesudahnya.`,
      );
      return;
    }
    if (sub === "status") {
      const chains = flag("--chains") ? flag("--chains").split(",").map((s) => s.trim()) : DEFAULT_CHAIN_NAMES;
      const rows = await relayerStatus(chains);
      const human = rows
        .map((r) => (r.exists ? `  ${r.chain.padEnd(10)} ${r.address}  ${r.balanceFormatted} ${r.symbol} (nonce ${r.nonce}) — ${r.level}` : `  ${r.chain.padEnd(10)} belum ada relayer tetap`))
        .join("\n");
      out(rows, `Status relayer tetap (${RELAYER_DIR}):\n${human}`);
      return;
    }
    if (sub === "sweep") {
      const chain = flag("--chain");
      const relayerFile = flag("--relayer-file");
      const to = flag("--to");
      if (!chain || !relayerFile || !to || !isAddress(to)) die("wajib: --chain, --relayer-file, --to <alamat valid>");
      const res = await sweepRelayer({ chainName: chain, relayerKey: keyFromFile(relayerFile), to });
      out(res, `Sweep terkirim: ${res.txHash}\n${res.sweptFormatted} dikembalikan dari ${res.from} ke ${res.to} (status ${res.status})`);
      return;
    }
    if (sub === "burn") {
      const file = flag("--file");
      if (!file) die("wajib: --file");
      if (!file.startsWith(RELAYER_DIR)) die(`DITOLAK: burn hanya untuk berkas di dalam ${RELAYER_DIR}`);
      const res = burnRelayerFile(file);
      out(res, `Berkas kunci dimusnahkan (ditimpa acak lalu dihapus): ${res.burned}`);
      return;
    }
    die(`sub-perintah relayer tidak dikenal: ${sub ?? ""} (pakai: new | status | sweep | burn)`);
  }

  die(`perintah tidak dikenal: ${cmd}\n\n${HELP}`);
}

main().catch((e) => die(e?.shortMessage ?? e?.message ?? String(e)));
