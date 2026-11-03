// batch.mjs — dukungan BatchCallDelegationV2: SATU metode eksekusi smart
// wallet untuk agent-7702 (keputusan pemilik 2026-11-01: "satu untuk semua").
//
// Semua kemampuan smart wallet — kirim native, kirim token/NFT, klaim yang
// jumlahnya diketahui, panggilan kontrak umum, batch campuran — disusun
// menjadi SATU daftar Call[] yang ditandatangani pemilik sebagai intent
// EIP-712 dan dieksekusi BatchCallDelegationV2 lewat `executeSigned`.
// Relayer hanya mengirim + membayar gas; ia tidak bisa mengubah isi batch
// (tanda tangan mengikat persis calls + nonce + deadline, domain terikat
// akun + chain).
//
// Dua mode eksekusi:
//   A) Delegate sudah terpasang → relayer mengirim tx biasa ke akun.
//   B) Belum terpasang + intent membawa otorisasi pemasangan → SATU tx
//      tipe-4: otorisasi memasang delegate, badan tx langsung executeSigned.
// Keduanya selalu didahului simulasi; intent yang gagal simulasi tidak
// pernah dikirim.
import {
  createWalletClient,
  http,
  encodeFunctionData,
  decodeFunctionData,
  hashTypedData,
  recoverAddress,
  parseEventLogs,
  isAddress,
  formatEther,
  parseUnits,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { resolveChain } from "./chains.mjs";
import { publicClient, parseDelegation, submitAuthorization, signAuth } from "./core.mjs";

// Registri delegate batch per chainId. Alamat lowercase tidak wajib (viem
// menangani campuran), tetapi disimpan checksummed agar mudah dibaca.
// Mainnet SENGAJA kosong: pemasangan per chain adalah keputusan + deploy
// terpisah dari pemilik (CREATE2, alamat seragam) — bukan bawaan rilis ini.
export const BATCH_DELEGATES = {
  11155111: "0x1591DdA47F3b34a3441d8a4213C1bB51401108a8",
};

export function batchDelegateFor(chainId) {
  return BATCH_DELEGATES[chainId] ?? null;
}

export const BATCH_ABI = [
  {
    type: "function",
    name: "executeSigned",
    stateMutability: "payable",
    inputs: [
      {
        name: "calls",
        type: "tuple[]",
        components: [
          { name: "to", type: "address" },
          { name: "value", type: "uint256" },
          { name: "data", type: "bytes" },
        ],
      },
      { name: "nonce", type: "uint256" },
      { name: "deadline", type: "uint256" },
      { name: "signature", type: "bytes" },
    ],
    outputs: [],
  },
  { type: "function", name: "nonce", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
  {
    type: "function",
    name: "getDigest",
    stateMutability: "view",
    inputs: [
      {
        name: "calls",
        type: "tuple[]",
        components: [
          { name: "to", type: "address" },
          { name: "value", type: "uint256" },
          { name: "data", type: "bytes" },
        ],
      },
      { name: "nonce", type: "uint256" },
      { name: "deadline", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bytes32" }],
  },
  {
    type: "event",
    name: "BatchExecuted",
    inputs: [
      { name: "executor", type: "address", indexed: true },
      { name: "nonce", type: "uint256", indexed: true },
      { name: "viaSignature", type: "bool" },
      { name: "callCount", type: "uint256" },
    ],
  },
];

const ERC20_ABI = [
  { type: "function", name: "transfer", stateMutability: "nonpayable", inputs: [{ name: "to", type: "address" }, { name: "value", type: "uint256" }], outputs: [{ name: "", type: "bool" }] },
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ name: "spender", type: "address" }, { name: "value", type: "uint256" }], outputs: [{ name: "", type: "bool" }] },
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "account", type: "address" }], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint8" }] },
  { type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "string" }] },
];

// Selector yang layak diperingatkan keras sebelum pemilik menandatangani:
// mereka memberi kuasa atas aset ke pihak lain atau memindahkan aset pihak
// lain — sah di dalam batch bertanda tangan pemilik, tetapi tidak boleh
// pernah lolos tanpa terlihat.
const SENSITIVE = {
  "0x095ea7b3": "approve — memberi allowance token ke spender",
  "0x39509351": "increaseAllowance — menaikkan allowance token",
  "0xa22cb465": "setApprovalForAll — kuasa penuh atas koleksi NFT",
  "0x23b872dd": "transferFrom — memindahkan token dari alamat lain",
  "0x42842e0e": "safeTransferFrom (ERC-721)",
  "0xf242432a": "safeTransferFrom (ERC-1155)",
  "0xd505accf": "permit (ERC-2612) — tanda tangan allowance di dalam batch",
};

export function selectorOf(data) {
  return data && data.length >= 10 ? data.slice(0, 10).toLowerCase() : null;
}

export function callWarnings(calls) {
  const out = [];
  calls.forEach((c, i) => {
    const sel = selectorOf(c.data);
    if (sel && SENSITIVE[sel]) out.push(`call #${i + 1} ke ${c.to}: ${SENSITIVE[sel]}`);
  });
  return out;
}

// Ringkasan terbaca manusia untuk satu call (dekode sebisanya).
export function describeCall(c) {
  const val = BigInt(c.value) > 0n ? ` + nilai ${formatEther(BigInt(c.value))} koin native` : "";
  const sel = selectorOf(c.data);
  if (sel === "0xa9059cbb") {
    try {
      const d = decodeFunctionData({ abi: ERC20_ABI, data: c.data });
      return `transfer token ${c.to} -> ${d.args[0]} sebesar ${d.args[1]} unit terkecil${val}`;
    } catch { /* jatuh ke ringkasan umum */ }
  }
  if (!c.data || c.data === "0x") return `kirim ${formatEther(BigInt(c.value))} koin native ke ${c.to}`;
  return `panggil ${c.to} selector ${sel ?? "?"} (${(c.data.length - 2) / 2} byte calldata)${val}`;
}

// --- Penyusun template: semuanya menghasilkan Call yang sama ----------------
export function nativeCall(to, valueWei) {
  return { to, value: BigInt(valueWei), data: "0x" };
}

export function erc20RawCall(token, to, rawAmount) {
  return {
    to: token,
    value: 0n,
    data: encodeFunctionData({ abi: ERC20_ABI, functionName: "transfer", args: [to, BigInt(rawAmount)] }),
  };
}

export async function erc20Call(chainName, token, to, humanAmount) {
  const info = resolveChain(chainName);
  if (!info) throw new Error(`chain tidak dikenal: ${chainName}`);
  const pub = publicClient(info);
  const decimals = await pub.readContract({ address: token, abi: ERC20_ABI, functionName: "decimals" });
  return erc20RawCall(token, to, parseUnits(String(humanAmount), decimals));
}

export function erc721Call(token, from, to, id) {
  return {
    to: token,
    value: 0n,
    data: encodeFunctionData({
      abi: [{ type: "function", name: "transferFrom", stateMutability: "nonpayable", inputs: [{ name: "from", type: "address" }, { name: "to", type: "address" }, { name: "tokenId", type: "uint256" }], outputs: [] }],
      functionName: "transferFrom",
      args: [from, to, BigInt(id)],
    }),
  };
}

export function erc1155Call(token, from, to, id, amount) {
  return {
    to: token,
    value: 0n,
    data: encodeFunctionData({
      abi: [{ type: "function", name: "safeTransferFrom", stateMutability: "nonpayable", inputs: [{ name: "from", type: "address" }, { name: "to", type: "address" }, { name: "id", type: "uint256" }, { name: "value", type: "uint256" }, { name: "data", type: "bytes" }], outputs: [] }],
      functionName: "safeTransferFrom",
      args: [from, to, BigInt(id), BigInt(amount), "0x"],
    }),
  };
}

export function rawCall(to, valueWei, data) {
  return { to, value: BigInt(valueWei), data };
}

// --- Keadaan akun -------------------------------------------------------------
export async function getBatchState(chainName, address) {
  const info = resolveChain(chainName);
  if (!info) throw new Error(`chain tidak dikenal: ${chainName}`);
  const pub = publicClient(info);
  const code = (await pub.getCode({ address })) ?? "0x";
  const delegate = parseDelegation(code);
  const expected = batchDelegateFor(info.chain.id);
  const isBatchDelegate = !!delegate && !!expected && delegate.toLowerCase() === expected.toLowerCase();
  let batchNonce = null;
  if (isBatchDelegate) {
    batchNonce = await pub.readContract({ address, abi: BATCH_ABI, functionName: "nonce" });
  }
  return {
    chain: chainName,
    chainId: info.chain.id,
    address,
    code,
    delegate,
    expectedDelegate: expected,
    isBatchDelegate,
    batchNonce: batchNonce === null ? null : batchNonce.toString(),
    accountNonce: await pub.getTransactionCount({ address }),
  };
}

// --- Digest EIP-712 -------------------------------------------------------------
const BATCH_TYPES = {
  Call: [
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "data", type: "bytes" },
  ],
  Execute: [
    { name: "calls", type: "Call[]" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
};

export function digestOf({ chainId, account, calls, nonce, deadline }) {
  return hashTypedData({
    domain: { name: "BatchCallDelegation", version: "2", chainId, verifyingContract: account },
    types: BATCH_TYPES,
    primaryType: "Execute",
    message: {
      calls: calls.map((c) => ({ to: c.to, value: BigInt(c.value), data: c.data })),
      nonce: BigInt(nonce),
      deadline: BigInt(deadline),
    },
  });
}

function serializeCalls(calls) {
  return calls.map((c) => ({ to: c.to, value: BigInt(c.value).toString(), data: c.data }));
}

// --- Tanda tangani batch -> intent ---------------------------------------------
export async function signBatch({ chainName, walletKey, calls, ttlMinutes = 30, batchNonce, withInstallAuth = false }) {
  const info = resolveChain(chainName);
  if (!info) throw new Error(`chain tidak dikenal: ${chainName}`);
  const delegate = batchDelegateFor(info.chain.id);
  if (!delegate) throw new Error(`BatchCallDelegationV2 belum terdaftar di chain ${chainName} (${info.chain.id}) — pemasangan per chain adalah keputusan terpisah.`);
  if (!calls || calls.length === 0) throw new Error("batch kosong — tidak ada yang ditandatangani");
  if (calls.length > 50) throw new Error("batch terlalu besar (maks 50 call)");
  const account = privateKeyToAccount(walletKey);
  const pub = publicClient(info);

  for (const [i, c] of calls.entries()) {
    if (!isAddress(c.to)) throw new Error(`call #${i + 1}: --to bukan alamat valid`);
    if (c.to.toLowerCase() === account.address.toLowerCase()) {
      throw new Error(`call #${i + 1}: target adalah akun itu sendiri — delegate melarang self-target, ditolak sejak di CLI`);
    }
  }
  const totalValue = calls.reduce((a, c) => a + BigInt(c.value), 0n);
  const nativeBalance = await pub.getBalance({ address: account.address });
  if (totalValue > nativeBalance) {
    throw new Error(`DITOLAK: total nilai native batch (${formatEther(totalValue)}) melebihi saldo akun (${formatEther(nativeBalance)})`);
  }

  const state = await getBatchState(chainName, account.address);
  let nonce;
  if (state.isBatchDelegate) {
    nonce = BigInt(state.batchNonce);
    if (batchNonce !== undefined && BigInt(batchNonce) !== nonce) {
      throw new Error(`DITOLAK: --batch-nonce ${batchNonce} tidak cocok dengan nonce on-chain ${nonce}`);
    }
  } else if (batchNonce !== undefined) {
    nonce = BigInt(batchNonce);
  } else if (!state.delegate) {
    // Akun bersih yang belum pernah memakai delegate ini: storage ERC-7201
    // masih kosong sehingga nonce mulai dari 0. Bila akun pernah memakai
    // lalu mencabutnya, nonce lama tetap hidup — operator WAJIB memberi
    // --batch-nonce yang benar; simulasi pra-kirim akan menangkap kesalahan.
    nonce = 0n;
  } else {
    throw new Error(`DITOLAK: akun sedang terdelegasi ke ${state.delegate}, bukan BatchCallDelegationV2 — cabut atau ganti delegasi dulu lewat delegate/revoke`);
  }

  const block = await pub.getBlock();
  const deadline = block.timestamp + BigInt(Math.round(ttlMinutes * 60));
  const norm = calls.map((c) => ({ to: c.to, value: BigInt(c.value), data: c.data }));
  const digest = digestOf({ chainId: info.chain.id, account: account.address, calls: norm, nonce, deadline });

  // Salib-periksa digest dengan kontrak itu sendiri bila delegate terpasang:
  // ketidakcocokan format EIP-712 tidak boleh lolos sebagai tanda tangan buta.
  let digestOnChain = null;
  if (state.isBatchDelegate) {
    digestOnChain = await pub.readContract({
      address: account.address,
      abi: BATCH_ABI,
      functionName: "getDigest",
      args: [norm, nonce, deadline],
    });
    if (digestOnChain.toLowerCase() !== digest.toLowerCase()) {
      throw new Error("DITOLAK: digest hitungan CLI tidak cocok dengan getDigest() on-chain — berhenti, jangan tanda tangani");
    }
  }

  const signature = await account.sign({ hash: digest });
  const intent = {
    kind: "batch-v2",
    chain: chainName,
    chainId: info.chain.id,
    account: account.address,
    delegate,
    calls: serializeCalls(norm),
    nonce: nonce.toString(),
    deadline: deadline.toString(),
    digest,
    digestVerifiedOnChain: digestOnChain !== null,
    warnings: callWarnings(norm),
    signature,
  };
  if (withInstallAuth) {
    if (state.isBatchDelegate) throw new Error("delegate sudah terpasang — --install tidak diperlukan");
    if (state.delegate) throw new Error("akun terdelegasi ke kontrak lain — mode pasang+eksekusi menolak menimpa delegasi asing");
    intent.authorization = await signAuth({ chainName, walletKey, to: delegate });
  }
  return intent;
}

// --- Verifikasi intent (offline + rantai) ---------------------------------------
export async function verifyIntent(intent) {
  if (intent.kind !== "batch-v2") throw new Error("berkas intent bukan batch-v2");
  const digest = digestOf(intent);
  if (digest.toLowerCase() !== intent.digest.toLowerCase()) {
    throw new Error("DITOLAK: isi intent tidak cocok dengan digest tersimpan — berkas telah berubah sejak ditandatangani");
  }
  const signer = await recoverAddress({ hash: intent.digest, signature: intent.signature });
  if (signer.toLowerCase() !== intent.account.toLowerCase()) {
    throw new Error(`DITOLAK: tanda tangan berasal dari ${signer}, bukan pemilik akun ${intent.account}`);
  }
  const expected = batchDelegateFor(intent.chainId);
  if (!expected || expected.toLowerCase() !== intent.delegate.toLowerCase()) {
    throw new Error("DITOLAK: delegate pada intent tidak cocok dengan registri CLI untuk chain ini");
  }
  return { digest, signer };
}

function executeCalldata(intent) {
  return encodeFunctionData({
    abi: BATCH_ABI,
    functionName: "executeSigned",
    args: [
      intent.calls.map((c) => ({ to: c.to, value: BigInt(c.value), data: c.data })),
      BigInt(intent.nonce),
      BigInt(intent.deadline),
      intent.signature,
    ],
  });
}

// --- Eksekusi ---------------------------------------------------------------------
export async function executeBatch({ chainName, relayerKey, intent }) {
  const info = resolveChain(chainName);
  if (!info) throw new Error(`chain tidak dikenal: ${chainName}`);
  if (intent.chainId !== info.chain.id) throw new Error(`DITOLAK: intent untuk chainId ${intent.chainId}, bukan ${chainName} (${info.chain.id})`);
  await verifyIntent(intent);
  const pub = publicClient(info);
  const block = await pub.getBlock();
  if (BigInt(intent.deadline) <= block.timestamp) throw new Error("DITOLAK: intent sudah kedaluwarsa — tanda tangani ulang");
  const state = await getBatchState(chainName, intent.account);
  const data = executeCalldata(intent);
  const relayer = privateKeyToAccount(relayerKey);
  const warnings = [];

  if (state.isBatchDelegate) {
    // Mode A — delegate sudah terpasang; relayer mengirim tx biasa.
    if (BigInt(state.batchNonce) !== BigInt(intent.nonce)) {
      throw new Error(`DITOLAK: intent basi — nonce intent ${intent.nonce}, nonce on-chain sekarang ${state.batchNonce}. Tanda tangani ulang.`);
    }
    try {
      await pub.call({ account: relayer.address, to: intent.account, data });
    } catch (e) {
      throw new Error(`DITOLAK (simulasi): executeSigned akan revert — ${String(e.shortMessage ?? e.message).slice(0, 300)}`);
    }
    const gasEst = await pub.estimateGas({ account: relayer.address, to: intent.account, data });
    const gasLimit = (gasEst * 13n) / 10n + 50_000n;
    const gasPrice = await pub.getGasPrice();
    const balance = await pub.getBalance({ address: relayer.address });
    if (balance < gasPrice * gasLimit) {
      throw new Error(`DITOLAK (preflight): float relayer ${relayer.address} tidak cukup — saldo ${formatEther(balance)} < estimasi ${formatEther(gasPrice * gasLimit)}`);
    }
    const client = createWalletClient({ account: relayer, chain: info.chain, transport: http(info.rpc) });
    const hash = await client.sendTransaction({ account: relayer, to: intent.account, data, gas: gasLimit });
    const receipt = await pub.waitForTransactionReceipt({ hash });
    return finishReceipt(pub, intent, hash, receipt, "terpasang");
  }

  // Mode B — satu tx tipe-4: pasang delegate + eksekusi, atomik.
  if (state.delegate) {
    throw new Error(`DITOLAK: akun terdelegasi ke ${state.delegate} (bukan BatchCallDelegationV2) — mode batch tidak menimpa delegasi asing`);
  }
  if (!intent.authorization) {
    throw new Error("DITOLAK: delegate belum terpasang dan intent tidak membawa otorisasi pemasangan — tanda tangani ulang dengan --install, atau pasang dulu lewat perintah delegate");
  }
  const auth = intent.authorization;
  const cleanAuth = { chainId: auth.chainId, address: auth.address, nonce: auth.nonce, r: auth.r, s: auth.s, yParity: auth.yParity };
  if (cleanAuth.address.toLowerCase() !== intent.delegate.toLowerCase()) {
    throw new Error("DITOLAK: otorisasi pada intent memasang alamat yang berbeda dari delegate batch");
  }
  try {
    await pub.call({ account: relayer.address, to: intent.account, data, authorizationList: [cleanAuth] });
  } catch (e) {
    throw new Error(`DITOLAK (simulasi tipe-4): batch akan revert — ${String(e.shortMessage ?? e.message).slice(0, 300)}`);
  }
  const gasEst = await pub.estimateGas({ account: relayer.address, to: intent.account, data, authorizationList: [cleanAuth] });
  const gasLimit = (gasEst * 13n) / 10n + 50_000n;
  const res = await submitAuthorization({ chainName, relayerKey, authorization: auth, authority: intent.account, data, gasLimit });
  const receipt = await pub.getTransactionReceipt({ hash: res.txHash });
  return finishReceipt(pub, intent, res.txHash, receipt, "satu-tx-tipe-4");
}

async function finishReceipt(pub, intent, hash, receipt, mode) {
  if (receipt.status !== "success") {
    return { txHash: hash, status: receipt.status, mode, account: intent.account, nonceAfter: null, executed: false };
  }
  const events = parseEventLogs({ abi: BATCH_ABI, logs: receipt.logs, eventName: "BatchExecuted" });
  const mine = events.filter((e) => e.address.toLowerCase() === intent.account.toLowerCase());
  const stateAfter = await getBatchState(intent.chain, intent.account);
  return {
    txHash: hash,
    status: receipt.status,
    mode,
    account: intent.account,
    gasUsed: receipt.gasUsed.toString(),
    batchEvent: mine.length > 0,
    nonceBefore: intent.nonce,
    nonceAfter: stateAfter.batchNonce,
    executed: mine.length > 0 && stateAfter.batchNonce === (BigInt(intent.nonce) + 1n).toString(),
  };
}
