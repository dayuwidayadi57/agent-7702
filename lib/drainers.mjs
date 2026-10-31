// Kontrak delegate yang DIKENAL sebagai drainer, dari kasus nyata yang
// terverifikasi on-chain. Alamat lowercase, dikunci per chainId.
export const KNOWN_DRAINERS = {
  1: {
    "0x63e842b054bd624a465454d533c33f573e9c6fae": "Sweeper perampokan Binance 14 (Okt 2026)",
    "0x0727ca41efc85f75cef26ee48f825893b4836786": "Delegate aktif pada dompet korban nyata (kasus 2025)",
  },
  8453: {
    "0x3f0b4724d3c548059b81f17d9083d3612d025936": "Delegate aktif pada dompet korban nyata (kasus 2025)",
  },
  56: {
    "0x9db96924a0b0b9a83fe2368b29539561a9c696d8": "Delegate aktif pada dompet korban nyata (kasus 2025)",
  },
  42161: {
    "0x22ed1827f5be793111e63c05c3f468adcce21095": "Delegate aktif pada dompet korban nyata (kasus 2025)",
  },
  10: {
    "0xe4f741b8b86f7379cd8d3f1d1bebedc971ef82e7": "Delegate aktif pada dompet korban nyata (kasus 2025)",
  },
  137: {
    "0xd1bc2349a57a0621deeb0a85e923991eb187a02d": "Delegate aktif pada dompet korban nyata (kasus 2025)",
  },
};

export function drainerLabel(chainId, delegate) {
  return KNOWN_DRAINERS[chainId]?.[delegate.toLowerCase()] ?? null;
}
