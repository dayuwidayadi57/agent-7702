// Registri arah baik: implementasi yang dikenal (smart account / delegate
// tepercaya), dikunci per chainId dengan hash bytecode terverifikasi.
// Kriteria masuk: source terverifikasi, audit/rekam jejak publik, bytecode
// cocok. Alamat lowercase.
//
// Sengaja baru berisi delegate uji internal di Sepolia — implementasi smart
// account mainnet ditambahkan hanya setelah diverifikasi satu per satu.
export const KNOWN_GOOD = {
  11155111: {
    "0x3e32bedfb4b74ed6c204b4b1eab0c2368d5b070e": "BenignDelegate — delegate uji internal (BUKAN smart account)",
    "0x81b00fe94881ccc287d5546e91e88b20042bac6a": "RescueDelegate agent-7702 (Atomic Rescue) — terverifikasi uji forge 7/7 + Sepolia",
    "0x0ed74cc59ecd38fb2bd6f6c8874b9a6f5130efe4": "RescueDelegateV2 agent-7702 (Atomic Claim Rescue) — terverifikasi uji forge 7/7 + Sepolia",
    "0x1591dda47f3b34a3441d8a4213c1bb51401108a8": "BatchCallDelegationV2 agent-7702 (smart wallet batch) — terverifikasi uji forge 11/11 + bukti live Sepolia (kirim native, kirim ERC20, claim+teruskan dalam satu tx tipe-4)",
  },
};

export function knownGoodLabel(chainId, address) {
  return KNOWN_GOOD[chainId]?.[address.toLowerCase()] ?? null;
}
