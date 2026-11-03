import { createWalletClient, http, parseEther, parseUnits, formatUnits, encodeFunctionData, encodeAbiParameters, stringToHex, zeroAddress, keccak256 } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { publicClient, parseDelegation } from "./core.mjs";
import { resolveChain } from "./chains.mjs";
import { drainerLabel } from "./drainers.mjs";

// Alamat RescueDelegate per chainId (registri — mainnet kosong sampai
// kontrak disebar + diverifikasi per chain).
export const RESCUE_DELEGATES = {
  11155111: "0x81b00fe94881ccc287d5546e91e88b20042bac6a",
};

export function rescueDelegateFor(chainId) {
  return RESCUE_DELEGATES[chainId] ?? null;
}

export const RESCUE_ABI = [
  {
    type: "function",
    name: "execute",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "intent",
        type: "tuple",
        components: [
          { name: "to", type: "address" },
          { name: "nonce", type: "uint256" },
          { name: "expiry", type: "uint256" },
          {
            name: "actions",
            type: "tuple[]",
            components: [
              { name: "kind", type: "uint8" },
              { name: "token", type: "address" },
              { name: "amount", type: "uint256" },
              { name: "tokenId", type: "uint256" },
            ],
          },
        ],
      },
      { name: "signature", type: "bytes" },
    ],
    outputs: [],
  },
];

export const INTENT_TYPES = {
  Intent: [
    { name: "to", type: "address" },
    { name: "nonce", type: "uint256" },
    { name: "expiry", type: "uint256" },
    { name: "actions", type: "Action[]" },
  ],
  Action: [
    { name: "kind", type: "uint8" },
    { name: "token", type: "address" },
    { name: "amount", type: "uint256" },
    { name: "tokenId", type: "uint256" },
  ],
};

const ERC20_ABI = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "a", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
  { type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "transfer", stateMutability: "nonpayable", inputs: [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ type: "bool" }] },
];
const ERC721_ABI = [
  { type: "function", name: "ownerOf", stateMutability: "view", inputs: [{ name: "id", type: "uint256" }], outputs: [{ type: "address" }] },
  { type: "function", name: "transferFrom", stateMutability: "nonpayable", inputs: [{ name: "from", type: "address" }, { name: "to", type: "address" }, { name: "id", type: "uint256" }], outputs: [] },
];
const ERC1155_ABI = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "a", type: "address" }, { name: "id", type: "uint256" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "safeTransferFrom", stateMutability: "nonpayable", inputs: [{ name: "from", type: "address" }, { name: "to", type: "address" }, { name: "id", type: "uint256" }, { name: "amount", type: "uint256" }, { name: "data", type: "bytes" }], outputs: [] },
];

const BLOCKSCOUT_HOSTS = {
  1: "eth.blockscout.com",
  8453: "base.blockscout.com",
  56: "bsc.blockscout.com",
  42161: "arbitrum.blockscout.com",
  10: "optimism.blockscout.com",
  137: "polygon.blockscout.com",
  11155111: "eth-sepolia.blockscout.com",
};

// Inventaris aset satu alamat di satu chain: native (RPC) + token/NFT
// (Blockscout bila tersedia; token eksplisit via RPC sebagai cadangan).
export async function getAssets(chainName, address, extraTokens = []) {
  const info = resolveChain(chainName);
  if (!info) throw new Error(`chain tidak dikenal: ${chainName}`);
  const pub = publicClient(info);
  const [native, code] = await Promise.all([pub.getBalance({ address }), pub.getCode({ address })]);
  const assets = { chain: chainName, chainId: info.chain.id, address, delegatedTo: parseDelegation(code), native: native.toString(), tokens: [], nfts: [], source: "rpc", warning: null };
  const host = BLOCKSCOUT_HOSTS[info.chain.id];
  if (host) {
    try {
      const res = await fetch(`https://${host}/api/v2/addresses/${address}/token-balances`, {
        headers: { "User-Agent": "agent-7702-cli", accept: "application/json" },
        signal: AbortSignal.timeout(12000),
      });
      if (res.ok) {
        const items = await res.json();
        assets.source = "blockscout";
        for (const it of items) {
          const t = it.token ?? {};
          const type = (t.type ?? "").toUpperCase();
          if (type === "ERC-20") assets.tokens.push({ address: t.address_hash, name: t.name, symbol: t.symbol, decimals: Number(t.decimals ?? 18), balance: String(it.value ?? "0") });
          else if (type === "ERC-721") assets.nfts.push({ address: t.address_hash, name: t.name, symbol: t.symbol, standard: "ERC721", tokenId: String(it.token_id ?? "") });
          else if (type === "ERC-1155") assets.nfts.push({ address: t.address_hash, name: t.name, symbol: t.symbol, standard: "ERC1155", tokenId: String(it.token_id ?? ""), balance: String(it.value ?? "0") });
        }
      } else assets.warning = `Blockscout menjawab ${res.status}; hanya data RPC + token eksplisit.`;
    } catch (e) {
      assets.warning = `Blockscout tidak terjangkau (${e.message}); hanya data RPC + token eksplisit.`;
    }
  }
  for (const token of extraTokens) {
    try {
      const [bal, dec, sym] = await Promise.all([
        pub.readContract({ address: token, abi: ERC20_ABI, functionName: "balanceOf", args: [address] }),
        pub.readContract({ address: token, abi: ERC20_ABI, functionName: "decimals" }).catch(() => 18),
        pub.readContract({ address: token, abi: ERC20_ABI, functionName: "symbol" }).catch(() => "?"),
      ]);
      if (bal > 0n && !assets.tokens.some((t) => t.address.toLowerCase() === token.toLowerCase())) {
        assets.tokens.push({ address: token, name: sym, symbol: sym, decimals: Number(dec), balance: bal.toString(), via: "rpc-explicit" });
      }
    } catch { /* abaikan token yang tidak terbaca sebagai ERC20 */ }
  }
  return assets;
}

const TOPUP_DEFAULTS = { 1: "0.003", 8453: "0.001", 56: "0.002", 42161: "0.001", 10: "0.001", 137: "0.5", 11155111: "0.005" };

export function topupAmountFor(chainName) {
  const info = resolveChain(chainName);
  return parseEther(TOPUP_DEFAULTS[info.chain.id] ?? "0.002");
}

// Isi debu gas dari relayer ke dompet yang SUDAH BERSIH. Menolak keras bila
// target masih terdelegasi (mengisi dompet terdelegasi = memberi makan drainer).
export async function topup({ chainName, relayerKey, to, amount }) {
  const info = resolveChain(chainName);
  if (!info) throw new Error(`chain tidak dikenal: ${chainName}`);
  const pub = publicClient(info);
  const code = (await pub.getCode({ address: to })) ?? "0x";
  if (code !== "0x") {
    throw new Error(`DITOLAK: ${to} masih memiliki kode (${code}) — topup hanya untuk dompet bersih. Cabut delegasinya dulu (revoke).`);
  }
  const value = amount ? parseEther(amount) : parseEther(TOPUP_DEFAULTS[info.chain.id] ?? "0.002");
  const relayer = privateKeyToAccount(relayerKey);
  const [bal, gasPrice] = await Promise.all([pub.getBalance({ address: relayer.address }), pub.getGasPrice()]);
  if (bal < value + gasPrice * 21_000n * 2n) throw new Error("DITOLAK (preflight): float relayer tidak cukup untuk topup ini.");
  const client = createWalletClient({ account: relayer, chain: info.chain, transport: http(info.rpc) });
  const hash = await client.sendTransaction({ account: relayer, to, value });
  const receipt = await pub.waitForTransactionReceipt({ hash });
  return { txHash: hash, status: receipt.status, from: relayer.address, to, amount: value.toString() };
}

// Kirim ERC20 dari dompet pemilik (kuncinya sendiri). amount: string satuan
// manusia ("12.5") atau "all"; atau rawAmount: string unit dasar persis
// (dipakai orkestrasi rescue agar tidak ada pembulatan desimal).
export async function sendToken({ chainName, walletKey, token, to, amount, rawAmount }) {
  const info = resolveChain(chainName);
  if (!info) throw new Error(`chain tidak dikenal: ${chainName}`);
  const pub = publicClient(info);
  const account = privateKeyToAccount(walletKey);
  const [bal, dec, sym] = await Promise.all([
    pub.readContract({ address: token, abi: ERC20_ABI, functionName: "balanceOf", args: [account.address] }),
    pub.readContract({ address: token, abi: ERC20_ABI, functionName: "decimals" }).catch(() => 18),
    pub.readContract({ address: token, abi: ERC20_ABI, functionName: "symbol" }).catch(() => "?"),
  ]);
  const value = rawAmount != null ? BigInt(rawAmount) : amount === "all" ? bal : parseUnits(amount, Number(dec));
  if (value <= 0n) throw new Error("jumlah kirim nol");
  if (value > bal) throw new Error(`saldo ${sym} tidak cukup: punya ${formatUnits(bal, Number(dec))}, mau kirim ${formatUnits(value, Number(dec))}`);
  const client = createWalletClient({ account, chain: info.chain, transport: http(info.rpc) });
  const hash = await client.writeContract({ address: token, abi: ERC20_ABI, functionName: "transfer", args: [to, value], account, gas: 150_000n });
  const receipt = await pub.waitForTransactionReceipt({ hash });
  return { txHash: hash, status: receipt.status, token, symbol: sym, from: account.address, to, amountRaw: value.toString(), amountFormatted: formatUnits(value, Number(dec)) };
}

// Kirim NFT dari dompet pemilik. Standar dideteksi: ownerOf (ERC721) dulu,
// lalu balanceOf ERC1155.
export async function sendNft({ chainName, walletKey, token, id, to, amount }) {
  const info = resolveChain(chainName);
  if (!info) throw new Error(`chain tidak dikenal: ${chainName}`);
  const pub = publicClient(info);
  const account = privateKeyToAccount(walletKey);
  const client = createWalletClient({ account, chain: info.chain, transport: http(info.rpc) });
  let is721 = false;
  try {
    const owner = await pub.readContract({ address: token, abi: ERC721_ABI, functionName: "ownerOf", args: [BigInt(id)] });
    is721 = owner.toLowerCase() === account.address.toLowerCase();
    if (!is721) throw new Error(`NFT ${id} bukan milik ${account.address} (pemilik: ${owner})`);
  } catch (e) {
    if (String(e.message).includes("bukan milik")) throw e;
  }
  if (is721) {
    const hash = await client.writeContract({ address: token, abi: ERC721_ABI, functionName: "transferFrom", args: [account.address, to, BigInt(id)], account, gas: 200_000n });
    const receipt = await pub.waitForTransactionReceipt({ hash });
    return { txHash: hash, status: receipt.status, standard: "ERC721", token, id: String(id), from: account.address, to };
  }
  const bal = await pub.readContract({ address: token, abi: ERC1155_ABI, functionName: "balanceOf", args: [account.address, BigInt(id)] });
  const qty = amount ? BigInt(amount) : 1n;
  if (bal < qty) throw new Error(`saldo ERC1155 id ${id} tidak cukup: ${bal}`);
  const hash = await client.writeContract({ address: token, abi: ERC1155_ABI, functionName: "safeTransferFrom", args: [account.address, to, BigInt(id), qty, "0x"], account, gas: 200_000n });
  const receipt = await pub.waitForTransactionReceipt({ hash });
  return { txHash: hash, status: receipt.status, standard: "ERC1155", token, id: String(id), amount: qty.toString(), from: account.address, to };
}

// Kirim koin native dari dompet pemilik (untuk sapu sisa sesudah topup).
export async function sendNative({ chainName, walletKey, to, amount }) {
  const info = resolveChain(chainName);
  const pub = publicClient(info);
  const account = privateKeyToAccount(walletKey);
  const bal = await pub.getBalance({ address: account.address });
  const fees = await pub.estimateFeesPerGas();
  const reserve = fees.maxFeePerGas * 32_000n; // batas gas 30000 pada fee yang sama + bantalan kecil
  const value = amount === "all" ? bal - reserve : parseEther(amount);
  if (value <= 0n) throw new Error("tidak ada native yang bisa dikirim sesudah cadangan gas");
  const client = createWalletClient({ account, chain: info.chain, transport: http(info.rpc) });
  const hash = await client.sendTransaction({ account, to, value, gas: 30_000n, maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas });
  const receipt = await pub.waitForTransactionReceipt({ hash });
  return { txHash: hash, status: receipt.status, from: account.address, to, amount: value.toString() };
}

// Susun intent penyelamatan. actions: [{kind, token, amount(raw string), tokenId}]
export function buildIntent({ chainId, to, actions, ttlMinutes = 15 }) {
  const now = Math.floor(Date.now() / 1000);
  return {
    to,
    nonce: String(Date.now()),
    expiry: String(now + ttlMinutes * 60),
    actions: actions.map((a) => ({
      kind: Number(a.kind),
      token: a.token ?? zeroAddress,
      amount: String(a.amount ?? "0"),
      tokenId: String(a.tokenId ?? "0"),
    })),
    chainId,
  };
}

function intentMessage(intent) {
  return {
    to: intent.to,
    nonce: BigInt(intent.nonce),
    expiry: BigInt(intent.expiry),
    actions: intent.actions.map((a) => ({ kind: a.kind, token: a.token, amount: BigInt(a.amount), tokenId: BigInt(a.tokenId) })),
  };
}

// Tanda tangani intent (EIP-712) oleh pemilik dompet.
export async function signIntent({ chainName, walletKey, intent }) {
  const info = resolveChain(chainName);
  if (!info) throw new Error(`chain tidak dikenal: ${chainName}`);
  const account = privateKeyToAccount(walletKey);
  const client = createWalletClient({ account, chain: info.chain, transport: http(info.rpc) });
  const signature = await client.signTypedData({
    account,
    domain: { name: "Agent7702Rescue", version: "1", chainId: info.chain.id, verifyingContract: account.address },
    types: INTENT_TYPES,
    primaryType: "Intent",
    message: intentMessage(intent),
  });
  return { ...intent, wallet: account.address, signature };
}

// TX ATOMIK: satu transaksi tipe-4 dari relayer — authorizationList memasang
// RescueDelegate, panggilan execute(intent) memanen. Menolak auth yang
// targetnya bukan RescueDelegate terdaftar untuk chain ini.
export async function executeAtomic({ chainName, relayerKey, authorization, intentSigned }) {
  const info = resolveChain(chainName);
  if (!info) throw new Error(`chain tidak dikenal: ${chainName}`);
  const expected = rescueDelegateFor(info.chain.id);
  if (!expected) throw new Error(`RescueDelegate belum tersebar/terdaftar untuk ${chainName} — Atomic Rescue belum tersedia di chain ini.`);
  if (String(authorization.address).toLowerCase() !== expected.toLowerCase()) {
    throw new Error(`DITOLAK: otorisasi ini menuju ${authorization.address}, bukan RescueDelegate terdaftar (${expected}).`);
  }
  const wallet = intentSigned.wallet;
  if (!wallet) throw new Error("intent tidak memuat field wallet");
  const data = encodeFunctionData({ abi: RESCUE_ABI, functionName: "execute", args: [intentMessage(intentSigned), intentSigned.signature] });
  const relayer = privateKeyToAccount(relayerKey);
  const pub = publicClient(info);
  const [bal, gasPrice] = await Promise.all([pub.getBalance({ address: relayer.address }), pub.getGasPrice()]);
  const estimate = gasPrice * 800_000n;
  if (bal < estimate) throw new Error(`DITOLAK (preflight): float relayer ${relayer.address} tidak cukup untuk tx atomik (estimasi ${estimate} wei).`);
  const client = createWalletClient({ account: relayer, chain: info.chain, transport: http(info.rpc) });
  const cleanAuth = { chainId: authorization.chainId, address: authorization.address, nonce: authorization.nonce, r: authorization.r, s: authorization.s, yParity: authorization.yParity };
  const hash = await client.sendTransaction({ account: relayer, authorizationList: [cleanAuth], to: wallet, data, gas: 900_000n });
  const receipt = await pub.waitForTransactionReceipt({ hash });
  const codeAfter = (await pub.getCode({ address: wallet })) ?? "0x";
  return { txHash: hash, status: receipt.status, relayer: relayer.address, wallet, codeAfter, delegatedTo: parseDelegation(codeAfter) };
}

// ===================== v2: Atomic Claim Rescue =====================
// Registri RescueDelegateV2 per chainId (terpisah dari v1; v1 tetap untuk
// misi transfer murni).
export const RESCUE_DELEGATES_V2 = {
  11155111: "0x0ed74cc59ecd38fb2bd6f6c8874b9a6f5130efe4",
};

export function rescueDelegateV2For(chainId) {
  const a = RESCUE_DELEGATES_V2[chainId];
  return a && a !== zeroAddress ? a : null;
}

export const RESCUE_V2_ABI = [
  {
    type: "function",
    name: "execute",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "intent",
        type: "tuple",
        components: [
          { name: "to", type: "address" },
          { name: "nonce", type: "uint256" },
          { name: "expiry", type: "uint256" },
          {
            name: "actions",
            type: "tuple[]",
            components: [
              { name: "kind", type: "uint8" },
              { name: "token", type: "address" },
              { name: "amount", type: "uint256" },
              { name: "tokenId", type: "uint256" },
              { name: "target", type: "address" },
              { name: "callHash", type: "bytes32" },
            ],
          },
        ],
      },
      { name: "signature", type: "bytes" },
      { name: "claimDatas", type: "bytes[]" },
    ],
    outputs: [],
  },
];

export const INTENT_TYPES_V2 = {
  Intent: [
    { name: "to", type: "address" },
    { name: "nonce", type: "uint256" },
    { name: "expiry", type: "uint256" },
    { name: "actions", type: "Action[]" },
  ],
  Action: [
    { name: "kind", type: "uint8" },
    { name: "token", type: "address" },
    { name: "amount", type: "uint256" },
    { name: "tokenId", type: "uint256" },
    { name: "target", type: "address" },
    { name: "callHash", type: "bytes32" },
  ],
};

// Susun intent v2. Aksi kind 4 (CLAIM) membaca a.claim = {contract, data};
// callHash dihitung di sini dari data persis yang akan dieksekusi.
export function buildIntentV2({ chainId, to, actions, ttlMinutes = 15 }) {
  const now = Math.floor(Date.now() / 1000);
  return {
    to,
    nonce: String(Date.now()),
    expiry: String(now + ttlMinutes * 60),
    actions: actions.map((a) => {
      if (Number(a.kind) === 4) {
        const data = a.claim?.data;
        const contract = a.claim?.contract;
        if (!data || !contract) throw new Error("aksi CLAIM wajib memiliki claim.contract dan claim.data");
        return { kind: 4, token: a.token ?? zeroAddress, amount: "0", tokenId: "0", target: contract, callHash: keccak256(data), claimData: data };
      }
      return { kind: Number(a.kind), token: a.token ?? zeroAddress, amount: String(a.amount ?? "0"), tokenId: String(a.tokenId ?? "0"), target: zeroAddress, callHash: "0x" + "0".repeat(64) };
    }),
    chainId,
  };
}

function intentMessageV2(intent) {
  return {
    to: intent.to,
    nonce: BigInt(intent.nonce),
    expiry: BigInt(intent.expiry),
    actions: intent.actions.map((a) => ({ kind: a.kind, token: a.token, amount: BigInt(a.amount), tokenId: BigInt(a.tokenId), target: a.target, callHash: a.callHash })),
  };
}

export async function signIntentV2({ chainName, walletKey, intent }) {
  const info = resolveChain(chainName);
  if (!info) throw new Error(`chain tidak dikenal: ${chainName}`);
  const account = privateKeyToAccount(walletKey);
  const client = createWalletClient({ account, chain: info.chain, transport: http(info.rpc) });
  const signature = await client.signTypedData({
    account,
    domain: { name: "Agent7702Rescue", version: "2", chainId: info.chain.id, verifyingContract: account.address },
    types: INTENT_TYPES_V2,
    primaryType: "Intent",
    message: intentMessageV2(intent),
  });
  return { ...intent, wallet: account.address, signature };
}

// TX ATOMIK v2: authorizationList memasang RescueDelegateV2; execute()
// menjalankan intent (termasuk aksi CLAIM dengan calldata terkomit).
export async function executeAtomicV2({ chainName, relayerKey, authorization, intentSigned }) {
  const info = resolveChain(chainName);
  if (!info) throw new Error(`chain tidak dikenal: ${chainName}`);
  const expected = rescueDelegateV2For(info.chain.id);
  if (!expected) throw new Error(`RescueDelegateV2 belum tersebar/terdaftar untuk ${chainName} — Claim Rescue belum tersedia di chain ini.`);
  if (String(authorization.address).toLowerCase() !== expected.toLowerCase()) {
    throw new Error(`DITOLAK: otorisasi ini menuju ${authorization.address}, bukan RescueDelegateV2 terdaftar (${expected}).`);
  }
  const wallet = intentSigned.wallet;
  if (!wallet) throw new Error("intent tidak memuat field wallet");
  const claimDatas = intentSigned.actions.filter((a) => a.kind === 4).map((a) => a.claimData);
  if (claimDatas.some((d) => !d)) throw new Error("aksi CLAIM kehilangan claimData — intent tidak lengkap");
  const data = encodeFunctionData({ abi: RESCUE_V2_ABI, functionName: "execute", args: [intentMessageV2(intentSigned), intentSigned.signature, claimDatas] });
  const relayer = privateKeyToAccount(relayerKey);
  const pub = publicClient(info);
  const [bal, gasPrice] = await Promise.all([pub.getBalance({ address: relayer.address }), pub.getGasPrice()]);
  const estimate = gasPrice * 1_000_000n;
  if (bal < estimate) throw new Error(`DITOLAK (preflight): float relayer ${relayer.address} tidak cukup untuk tx atomik v2 (estimasi ${estimate} wei).`);
  const client = createWalletClient({ account: relayer, chain: info.chain, transport: http(info.rpc) });
  const cleanAuth = { chainId: authorization.chainId, address: authorization.address, nonce: authorization.nonce, r: authorization.r, s: authorization.s, yParity: authorization.yParity };
  const hash = await client.sendTransaction({ account: relayer, authorizationList: [cleanAuth], to: wallet, data, gas: 1_200_000n });
  const receipt = await pub.waitForTransactionReceipt({ hash });
  const codeAfter = (await pub.getCode({ address: wallet })) ?? "0x";
  return { txHash: hash, status: receipt.status, relayer: relayer.address, wallet, codeAfter, delegatedTo: parseDelegation(codeAfter) };
}

// ===================== claim-check (Fase 0, read-only) =====================
const TOKEN_FN_ABI = [{ type: "function", name: "token", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] }];
const CLAIMED_PROBES = [
  { sig: "isClaimed(uint256,address)", abi: [{ type: "function", name: "isClaimed", stateMutability: "view", inputs: [{ type: "uint256" }, { type: "address" }], outputs: [{ type: "bool" }] }], args: (a) => [BigInt(a.index), a.wallet] },
  { sig: "isClaimed(uint256)", abi: [{ type: "function", name: "isClaimed", stateMutability: "view", inputs: [{ type: "uint256" }], outputs: [{ type: "bool" }] }], args: (a) => [BigInt(a.index)] },
  { sig: "claimed(uint256,address)", abi: [{ type: "function", name: "claimed", stateMutability: "view", inputs: [{ type: "uint256" }, { type: "address" }], outputs: [{ type: "bool" }] }], args: (a) => [BigInt(a.index), a.wallet] },
];

// Rakit argumen claim dari fragmen ABI apa pun yang bentuknya umum:
// uint256 bernama/posisi index -> index, uint256 lain -> amount,
// address -> dompet, bytes32[] -> proof. Mengembalikan null bila ada
// parameter yang tidak bisa dipetakan.
function assembleClaimArgs(fnAbi, { index, wallet, amount, proof }) {
  const args = [];
  let uintSeen = 0;
  for (const inp of fnAbi.inputs ?? []) {
    if (inp.type === "uint256") {
      const nm = (inp.name ?? "").toLowerCase();
      if (nm.includes("amount") || nm.includes("value")) args.push(BigInt(amount));
      else if (nm.includes("index") || nm.includes("id")) args.push(BigInt(index));
      else { args.push(uintSeen === 0 ? BigInt(index) : BigInt(amount)); uintSeen++; }
    } else if (inp.type === "address") args.push(wallet);
    else if (inp.type === "bytes32[]") args.push(proof);
    else return null;
  }
  return args;
}

// Periksa kontrak claim untuk satu dompet: identifikasi token hadiah,
// fungsi claim (ABI terverifikasi Blockscout bila ada), status terklaim,
// dan — bila berkas alokasi diberikan — buktikan lewat SIMULASI eth_call.
// Mengembalikan juga entri aksi kind-4 siap pakai untuk berkas aset.
export async function claimCheck({ chainName, contract, wallet, allocation }) {
  const info = resolveChain(chainName);
  if (!info) throw new Error(`chain tidak dikenal: ${chainName}`);
  const pub = publicClient(info);
  const out = { chain: chainName, chainId: info.chain.id, contract, wallet, contractName: null, verified: null, token: null, tokenSymbol: null, tokenDecimals: null, claimFunctions: [], alreadyClaimed: null, claimedProbe: null, allocationVerified: null, action: null, warnings: [] };
  const code = (await pub.getCode({ address: contract })) ?? "0x";
  if (code === "0x") { out.warnings.push("alamat ini tidak memiliki kode kontrak"); return out; }
  try { out.token = await pub.readContract({ address: contract, abi: TOKEN_FN_ABI, functionName: "token" }); }
  catch { out.warnings.push("token() tidak terbaca — kontrak mungkin memakai nama fungsi lain untuk token hadiah"); }
  if (out.token) {
    out.tokenSymbol = await pub.readContract({ address: out.token, abi: ERC20_ABI, functionName: "symbol" }).catch(() => "?");
    const dec = await pub.readContract({ address: out.token, abi: ERC20_ABI, functionName: "decimals" }).catch(() => 18);
    out.tokenDecimals = Number(dec);
  }
  // ABI terverifikasi dari Blockscout (bila chain punya instansnya).
  let abi = null;
  const host = BLOCKSCOUT_HOSTS[info.chain.id];
  if (host) {
    try {
      const res = await fetch(`https://${host}/api/v2/smart-contracts/${contract}`, { headers: { "User-Agent": "agent-7702-cli", accept: "application/json" }, signal: AbortSignal.timeout(12000) });
      if (res.ok) {
        const j = await res.json();
        abi = j.abi ?? null;
        out.contractName = j.name ?? null;
        out.verified = Boolean(j.is_verified);
      } else out.warnings.push(`Blockscout menjawab ${res.status} untuk kontrak ini`);
    } catch (e) { out.warnings.push(`Blockscout tidak terjangkau (${e.message})`); }
  }
  let claimFns = (abi ?? []).filter((f) => f.type === "function" && typeof f.name === "string" && f.name.toLowerCase().startsWith("claim"));
  out.shapeSource = claimFns.length ? "abi-terverifikasi" : null;
  if (!claimFns.length) {
    // Cadangan untuk kontrak tak terverifikasi: templat bentuk claim umum;
    // yang dipakai adalah yang pertama LOLOS simulasi dengan alokasi nyata.
    claimFns = [
      { type: "function", name: "claim", stateMutability: "nonpayable", inputs: [{ name: "index", type: "uint256" }, { name: "account", type: "address" }, { name: "amount", type: "uint256" }, { name: "merkleProof", type: "bytes32[]" }], outputs: [] },
      { type: "function", name: "claim", stateMutability: "nonpayable", inputs: [{ name: "account", type: "address" }, { name: "amount", type: "uint256" }, { name: "merkleProof", type: "bytes32[]" }], outputs: [] },
      { type: "function", name: "claim", stateMutability: "nonpayable", inputs: [{ name: "index", type: "uint256" }, { name: "amount", type: "uint256" }, { name: "merkleProof", type: "bytes32[]" }], outputs: [] },
    ];
    out.shapeSource = "templat (kontrak tidak terverifikasi — dibuktikan lewat simulasi)";
  }
  out.claimFunctions = claimFns.map((f) => `${f.name}(${(f.inputs ?? []).map((i) => i.type).join(",")})`);
  if (!claimFns.length) out.warnings.push("fungsi claim tidak ditemukan dari ABI terverifikasi — bentuk claim belum bisa dipastikan");

  if (allocation) {
    const alloc = { index: allocation.index ?? "0", wallet, amount: allocation.amount, proof: allocation.proof ?? [] };
    for (const probe of CLAIMED_PROBES) {
      try { out.alreadyClaimed = await pub.readContract({ address: contract, abi: probe.abi, functionName: probe.abi[0].name, args: probe.args(alloc) }); out.claimedProbe = probe.sig; break; }
      catch { /* coba probe berikutnya */ }
    }
    if (out.alreadyClaimed === null) out.warnings.push("status isClaimed tidak terbaca dari probe standar");
    // Pilih fungsi claim: utamakan yang parameternya bisa dirakit.
    let chosen = null; let args = null; let anyAssembled = false;
    for (const f of claimFns) {
      const a = assembleClaimArgs(f, alloc);
      if (!a) continue;
      anyAssembled = true;
      if (out.shapeSource.startsWith("templat")) {
        const d = encodeFunctionData({ abi: [f], functionName: f.name, args: a });
        try { await pub.call({ account: wallet, to: contract, data: d }); } catch { continue; }
      }
      chosen = f; args = a; break;
    }
    if (chosen) {
      const data = encodeFunctionData({ abi: [chosen], functionName: chosen.name, args });
      let simOk = false; let simErr = null;
      try { await pub.call({ account: wallet, to: contract, data }); simOk = true; }
      catch (e) { simErr = String(e.shortMessage ?? e.message).slice(0, 200); }
      out.allocationVerified = simOk;
      if (!simOk) out.warnings.push(`simulasi claim GAGAL: ${simErr}`);
      if (out.alreadyClaimed === true) out.warnings.push("alokasi ini SUDAH diklaim menurut kontrak");
      const amtFmt = out.tokenDecimals != null ? formatUnits(BigInt(alloc.amount), out.tokenDecimals) : String(alloc.amount);
      out.action = {
        kind: 4,
        token: out.token ?? zeroAddress,
        claim: { contract, data },
        note: `claim ${amtFmt} ${out.tokenSymbol ?? "token"} via ${chosen.name}(${(chosen.inputs ?? []).map((i) => i.type).join(",")}) index ${alloc.index} untuk ${wallet}`,
      };
    } else if (claimFns.length) {
      if (anyAssembled) { out.allocationVerified = false; out.warnings.push("tidak ada bentuk claim yang LOLOS simulasi dengan alokasi ini — index/jumlah/proof kemungkinan salah"); }
      else out.warnings.push("fungsi claim ditemukan tetapi parameternya di luar bentuk yang bisa dirakit otomatis");
    }
  }
  return out;
}

// ===================== v3: Relay-Call (DESIGN §12) =====================
// Registri RescueDelegateV3 per chainId (terpisah dari v1/v2).
export const RESCUE_DELEGATES_V3 = {
  11155111: "0xdF057afC121D0c4c29255a86992d924fD334a8C4",
};

export function rescueDelegateV3For(chainId) {
  const a = RESCUE_DELEGATES_V3[chainId];
  return a && a !== zeroAddress ? a : null;
}

export const RESCUE_V3_ABI = [
  {
    type: "function",
    name: "execute",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "intent",
        type: "tuple",
        components: [
          { name: "to", type: "address" },
          { name: "nonce", type: "uint256" },
          { name: "expiry", type: "uint256" },
          {
            name: "actions",
            type: "tuple[]",
            components: [
              { name: "kind", type: "uint8" },
              { name: "token", type: "address" },
              { name: "amount", type: "uint256" },
              { name: "tokenId", type: "uint256" },
              { name: "target", type: "address" },
              { name: "callHash", type: "bytes32" },
              { name: "forwardHash", type: "bytes32" },
            ],
          },
        ],
      },
      { name: "signature", type: "bytes" },
      { name: "datas", type: "bytes[]" },
      { name: "forwardSets", type: "address[][]" },
    ],
    outputs: [],
  },
];

export const INTENT_TYPES_V3 = {
  Intent: [
    { name: "to", type: "address" },
    { name: "nonce", type: "uint256" },
    { name: "expiry", type: "uint256" },
    { name: "actions", type: "Action[]" },
  ],
  Action: [
    { name: "kind", type: "uint8" },
    { name: "token", type: "address" },
    { name: "amount", type: "uint256" },
    { name: "tokenId", type: "uint256" },
    { name: "target", type: "address" },
    { name: "callHash", type: "bytes32" },
    { name: "forwardHash", type: "bytes32" },
  ],
};

const ZERO_HASH = "0x" + "0".repeat(64);

export function forwardHashOf(forwardTokens) {
  return keccak256(encodeAbiParameters([{ type: "address[]" }], [forwardTokens]));
}

// Susun intent v3. Aksi kind 4 membaca a.claim = {contract, data} (pola v2);
// aksi kind 5 (CALL) membaca a.call = {contract, data} dan a.forward =
// daftar alamat token yang gain-nya diteruskan ke tujuan intent.
export function buildIntentV3({ chainId, to, actions, ttlMinutes = 15 }) {
  const now = Math.floor(Date.now() / 1000);
  return {
    to,
    nonce: String(Date.now()),
    expiry: String(now + ttlMinutes * 60),
    actions: actions.map((a) => {
      const kind = Number(a.kind);
      if (kind === 4) {
        const data = a.claim?.data;
        const contract = a.claim?.contract;
        if (!data || !contract) throw new Error("aksi CLAIM wajib memiliki claim.contract dan claim.data");
        return { kind: 4, token: a.token ?? zeroAddress, amount: "0", tokenId: "0", target: contract, callHash: keccak256(data), forwardHash: ZERO_HASH, claimData: data };
      }
      if (kind === 5) {
        const data = a.call?.data;
        const contract = a.call?.contract;
        if (!data || !contract) throw new Error("aksi CALL wajib memiliki call.contract dan call.data");
        const forward = a.forward ?? [];
        return { kind: 5, token: zeroAddress, amount: "0", tokenId: "0", target: contract, callHash: keccak256(data), forwardHash: forwardHashOf(forward), callData: data, forwardTokens: forward };
      }
      return { kind, token: a.token ?? zeroAddress, amount: String(a.amount ?? "0"), tokenId: String(a.tokenId ?? "0"), target: zeroAddress, callHash: ZERO_HASH, forwardHash: ZERO_HASH };
    }),
    chainId,
  };
}

function intentMessageV3(intent) {
  return {
    to: intent.to,
    nonce: BigInt(intent.nonce),
    expiry: BigInt(intent.expiry),
    actions: intent.actions.map((a) => ({ kind: a.kind, token: a.token, amount: BigInt(a.amount), tokenId: BigInt(a.tokenId), target: a.target, callHash: a.callHash, forwardHash: a.forwardHash })),
  };
}

export async function signIntentV3({ chainName, walletKey, intent }) {
  const info = resolveChain(chainName);
  if (!info) throw new Error(`chain tidak dikenal: ${chainName}`);
  const account = privateKeyToAccount(walletKey);
  const client = createWalletClient({ account, chain: info.chain, transport: http(info.rpc) });
  const signature = await client.signTypedData({
    account,
    domain: { name: "Agent7702Rescue", version: "3", chainId: info.chain.id, verifyingContract: account.address },
    types: INTENT_TYPES_V3,
    primaryType: "Intent",
    message: intentMessageV3(intent),
  });
  return { ...intent, wallet: account.address, signature };
}

// TX ATOMIK v3: authorizationList memasang RescueDelegateV3; execute()
// menjalankan intent (aksi CLAIM + CALL dengan data terkomit hash).
export async function executeAtomicV3({ chainName, relayerKey, authorization, intentSigned }) {
  const info = resolveChain(chainName);
  if (!info) throw new Error(`chain tidak dikenal: ${chainName}`);
  const expected = rescueDelegateV3For(info.chain.id);
  if (!expected) throw new Error(`RescueDelegateV3 belum tersebar/terdaftar untuk ${chainName} — Relay-Call belum tersedia di chain ini.`);
  if (String(authorization.address).toLowerCase() !== expected.toLowerCase()) {
    throw new Error(`DITOLAK: otorisasi ini menuju ${authorization.address}, bukan RescueDelegateV3 terdaftar (${expected}).`);
  }
  const wallet = intentSigned.wallet;
  if (!wallet) throw new Error("intent tidak memuat field wallet");
  const datas = intentSigned.actions.filter((a) => a.kind === 4 || a.kind === 5).map((a) => a.claimData ?? a.callData);
  if (datas.some((d) => !d)) throw new Error("aksi CLAIM/CALL kehilangan datanya — intent tidak lengkap");
  const forwardSets = intentSigned.actions.filter((a) => a.kind === 5).map((a) => a.forwardTokens ?? []);
  const data = encodeFunctionData({ abi: RESCUE_V3_ABI, functionName: "execute", args: [intentMessageV3(intentSigned), intentSigned.signature, datas, forwardSets] });
  const relayer = privateKeyToAccount(relayerKey);
  const pub = publicClient(info);
  const [bal, gasPrice] = await Promise.all([pub.getBalance({ address: relayer.address }), pub.getGasPrice()]);
  const estimate = gasPrice * 1_300_000n;
  if (bal < estimate) throw new Error(`DITOLAK (preflight): float relayer ${relayer.address} tidak cukup untuk tx atomik v3 (estimasi ${estimate} wei).`);
  const client = createWalletClient({ account: relayer, chain: info.chain, transport: http(info.rpc) });
  const cleanAuth = { chainId: authorization.chainId, address: authorization.address, nonce: authorization.nonce, r: authorization.r, s: authorization.s, yParity: authorization.yParity };
  const hash = await client.sendTransaction({ account: relayer, authorizationList: [cleanAuth], to: wallet, data, gas: 1_500_000n });
  const receipt = await pub.waitForTransactionReceipt({ hash });
  const codeAfter = (await pub.getCode({ address: wallet })) ?? "0x";
  return { txHash: hash, status: receipt.status, relayer: relayer.address, wallet, codeAfter, delegatedTo: parseDelegation(codeAfter) };
}

// Selector yang TIDAK PERNAH boleh masuk relay-call (DESIGN §12.4 butir 3):
// persetujuan dan pemindahan aset dilayani perintah khusus; approve tidak
// punya tempat dalam misi penyelamatan.
export const SELECTOR_BLOCKLIST = {
  "0x095ea7b3": { name: "approve(address,uint256)", reason: "persetujuan pengeluaran token — vektor drainer klasik; tidak ada gunanya dalam misi penyelamatan" },
  "0x39509351": { name: "increaseAllowance(address,uint256)", reason: "menaikkan persetujuan pengeluaran token — sama berbahayanya dengan approve" },
  "0xa22cb465": { name: "setApprovalForAll(address,bool)", reason: "persetujuan koleksi NFT menyeluruh — vektor drainer klasik" },
  "0xa9059cbb": { name: "transfer(address,uint256)", reason: "pemindahan ERC20 dilayani perintah send-token / aksi intent kind 1 secara eksplisit" },
  "0x23b872dd": { name: "transferFrom(address,address,uint256)", reason: "pemindahan ERC20 pihak ketiga — tidak dilayani relay-call" },
  "0x42842e0e": { name: "safeTransferFrom(address,address,uint256)", reason: "pemindahan NFT dilayani perintah send-nft / aksi intent kind 2-3 secara eksplisit" },
  "0xb88d4fde": { name: "safeTransferFrom(address,address,uint256,bytes)", reason: "pemindahan NFT dilayani perintah send-nft / aksi intent kind 2-3 secara eksplisit" },
};

export function selectorOf(data) {
  return typeof data === "string" && data.startsWith("0x") && data.length >= 10 ? data.slice(0, 10).toLowerCase() : null;
}

// call-check (read-only): periksa satu panggilan kontrak untuk relay-call —
// target, selector, dan SIMULASI eth_call persis dari alamat dompet.
// Putusan: "DITOLAK" (pagar keras) | "SIMULASI GAGAL" | "LOLOS".
// Aturan rumah yang sama seperti claim-check: jangan pernah menandatangani
// panggilan yang belum lolos simulasi.
export async function callCheck({ chainName, wallet, target, data, forward = [], signatureName }) {
  const info = resolveChain(chainName);
  if (!info) throw new Error(`chain tidak dikenal: ${chainName}`);
  const pub = publicClient(info);
  const out = {
    chain: chainName, chainId: info.chain.id, wallet, target, data,
    selector: selectorOf(data), signatureName: signatureName ?? null, signatureMatches: null,
    targetCodeBytes: 0, drainer: null, blocked: null,
    forward: [], simulation: null, verdict: null, reasons: [],
  };
  if (!out.selector) { out.verdict = "DITOLAK"; out.reasons.push("calldata tidak valid (kurang dari 4 byte selector)"); return out; }
  const code = (await pub.getCode({ address: target })) ?? "0x";
  out.targetCodeBytes = (code.length - 2) / 2;
  if (out.targetCodeBytes === 0) { out.verdict = "DITOLAK"; out.reasons.push("target bukan kontrak (kode kosong)"); return out; }
  const dl = drainerLabel(info.chain.id, target);
  if (dl) { out.drainer = dl; out.verdict = "DITOLAK"; out.reasons.push(`target adalah kontrak drainer yang dikenal: ${dl}`); return out; }
  if (target.toLowerCase() === wallet.toLowerCase()) { out.verdict = "DITOLAK"; out.reasons.push("target adalah dompet itu sendiri"); return out; }
  const v3 = rescueDelegateV3For(info.chain.id);
  if (v3 && target.toLowerCase() === v3.toLowerCase()) { out.verdict = "DITOLAK"; out.reasons.push("target adalah RescueDelegateV3 — delegate tidak memanggil dirinya"); return out; }
  const blocked = SELECTOR_BLOCKLIST[out.selector];
  if (blocked) { out.blocked = blocked; out.verdict = "DITOLAK"; out.reasons.push(`selector ${out.selector} = ${blocked.name} DITOLAK: ${blocked.reason}`); return out; }
  if (signatureName) {
    const expect = keccak256(stringToHex(signatureName)).slice(0, 10);
    out.signatureMatches = expect === out.selector;
    if (!out.signatureMatches) out.reasons.push(`PERINGATAN: tanda tangan fungsi "${signatureName}" menghasilkan selector ${expect}, tidak cocok dengan calldata (${out.selector})`);
  }
  for (const t of forward) {
    const bal = await pub.readContract({ address: t, abi: ERC20_ABI, functionName: "balanceOf", args: [wallet] }).catch(() => null);
    out.forward.push({ token: t, walletBalanceBefore: bal === null ? null : bal.toString() });
  }
  try {
    const res = await pub.call({ account: wallet, to: target, data });
    out.simulation = { ok: true, returnData: res.data ?? "0x" };
    out.verdict = "LOLOS";
  } catch (e) {
    out.simulation = { ok: false, error: String(e.shortMessage ?? e.message).slice(0, 220) };
    out.verdict = "SIMULASI GAGAL";
    out.reasons.push(`simulasi eth_call revert: ${out.simulation.error}`);
  }
  return out;
}
