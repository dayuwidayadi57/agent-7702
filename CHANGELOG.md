# Changelog — agent-7702

Semua perubahan berarti dicatat di sini. Versi mengikuti SemVer
(mayor.minor.patch); selama 0.x, fitur baru menaikkan minor.
Sumber tunggal versi: field `version` di package.json
(periksa terpasang: `agent7702 --version`).

## 0.6.0 — rilis mainnet (disiapkan 2026-11-05)
- **RescueDelegateV4 LIVE di mainnet BSC**: `0x23c35334fd72302C6A58e379591d9c2F0833709D`
  (deploy 2026-11-05 via pabrik CREATE2, salt `keccak256("RESCUEDELEGATE-V4")`,
  bytecode on-chain terverifikasi cocok persis dengan artefak). Terdaftar di
  `RESCUE_DELEGATES_V4` (chain 56) + `lib/known-good.mjs`, sehingga perintah
  `mission` kini bekerja di BSC mainnet selain Sepolia; `check` mengenali
  delegate ini sebagai milik agent-7702 pada chain 56.
- **BatchCallDelegationV2 alamat mainnet BSC** (`0x40417919600bc4819B975a09992938a409495934`,
  live sejak 2026-11-04) kini ikut terbawa paket npm — pada 0.5.0 alamat ini
  baru terdaftar di repo GitHub.
- Catatan deploy: `contracts/mainnet-deployment-v4.json`.

## 0.5.0 — diterbitkan ke npm 2026-11-03 (disiapkan lokal 2026-11-01)
- Perintah baru `batch` + kontrak **BatchCallDelegationV2** (`contracts/src/`):
  dompet menjadi smart account PERSISTEN, dan semua aksi berjalan sebagai
  SATU batch bertanda tangan EIP-712 — kirim native/token/NFT, klaim yang
  jumlahnya diketahui, panggilan kontrak umum, batch campuran (keputusan
  pemilik: satu metode eksekusi, tanpa keluarga menu turunan). Dua mode:
  delegate sudah terpasang, atau pasang + eksekusi dalam satu tx tipe-4
  (`--install`). Template `--send` / `--send-token` / `--send-token-raw` /
  `--send-nft` / `--send-1155` / `--call` / `--calls`; alur intent terpisah
  `--sign-only` → `--intent`.
- Pagar batch: digest disalib-periksa ke `getDigest()` on-chain bila
  delegate terpasang; simulasi wajib sebelum kirim (mode tipe-4
  disimulasikan utuh dengan authorizationList); nonce basi dan replay
  ditolak di CLI sebelum transaksi dibuat; delegasi asing tidak ditimpa;
  selector sensitif (approve, setApprovalForAll, permit, …) selalu tampil
  sebagai peringatan di pratinjau.
- `submitAuthorization` digeneralisasi: kini dapat membawa calldata +
  batas gas dinamis dalam tx tipe-4 yang sama (perilaku bawaan identik —
  jalur cabut/pasang lama tidak berubah). `check` menampilkan nonce batch
  untuk dompet yang terdelegasi ke BatchCallDelegationV2.
- Uji: forge **34/34** (11 pengujian baru BatchCallDelegationV2). Bukti
  live Sepolia penuh LEWAT perintah `batch` itu sendiri: klaim 200 MOCK +
  teruskan ke alamat aman dalam satu tx tipe-4, kirim token mode
  terpasang, eksekusi intent terpisah, replay ditolak, `revoke`
  menyembuhkan dompet uji kembali bersih.

## Belum Dirilis — Relay-Call (2026-10-31, menunggu keputusan terbit)
- Perintah baru `call-check` + `relay-call` (DESIGN.md §12): panggilan
  kontrak umum berpagar via RescueDelegateV3 (Sepolia) — intent pemilik
  mengomit target + hash calldata + hash daftar token penerus; value
  terkunci 0; yang diteruskan ke tujuan hanya gain. Selector approve /
  setApprovalForAll / increaseAllowance / transfer / transferFrom /
  safeTransferFrom ditolak di lapisan CLI sebelum tanda tangan.
- Uji forge kontrak 23/23 (v1+v2+v3) dan bukti live Sepolia penuh
  (panggilan eksotik dari dompet terdelegasi BenignDelegate, gain token +
  native tiba persis, revoke penutup menyembuhkan).

## 0.4.1 — 2026-10-31
- README dipercantik: kepala terpusat dengan badge (versi npm, lisensi
  MIT, Node ≥18), tabel ketersediaan, bagian "For AI agents".
- Layar bantuan: banner detak jantung (ECG) khas Wallet Doctor.
- Layar bantuan kini berbahasa Inggris dan ringkas — indeks perintah
  per kelompok; cara pakai lengkap diarahkan ke SKILL.md.

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
