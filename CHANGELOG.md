# Changelog — agent-7702

Semua perubahan berarti dicatat di sini. Versi mengikuti SemVer
(mayor.minor.patch); selama 0.x, fitur baru menaikkan minor.
Sumber tunggal versi: field `version` di package.json
(periksa terpasang: `agent7702 --version`).

## 0.4.0 — 2026-10-31
- Atomic Claim Rescue: perintah `claim-check` (pengintaian kontrak
  airdrop, verifikasi alokasi lewat simulasi) dan `claim-rescue`.
- RescueDelegateV2 (domain EIP-712 versi "2", aksi kind 4 CLAIM dengan
  calldata terkomit hash) — deploy Sepolia + uji forge 7/7.
- Perintah `version` / `--version`; berkas CHANGELOG ini dimulai.

## 0.3.0 — 2026-10-31
- Penyelamatan aset Jalur A: `assets`, `topup` (menolak dompet
  terdelegasi), `send-token`, `send-nft`, `rescue` (orkestrasi).
- Atomic Rescue: `sign-intent`, `execute`, `atomic-rescue` +
  RescueDelegate v1 — terverifikasi live di Sepolia.
- Jurnal misi untuk `rescue` (lanjutan misi tanpa kirim ganda, `--fresh`).

## 0.2.0 — 2026-10-31
- Unifikasi nama agent-7702 (sebelumnya doctor7702 yang khusus cabut):
  satu alat dua arah — `sign-revoke`/`revoke` (target terkunci alamat
  nol) dan `sign-auth`/`delegate` (berpagar registri dua arah), `submit`,
  `check` multichain 7 chain.
- Model keamanan relayer: `relayer new|status|sweep|burn`, float mungil,
  preflight saldo, relayer sekali pakai, skrip watchdog.
