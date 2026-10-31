# Desain fitur: Penyelamatan Aset (rescue) — agent-7702

**Status:** DESAIN (ide dayu 2026-10-31, belum dibangun; proyek belum matang,
sengaja ditahan di desain dulu).
**Pertanyaan yang dijawab dokumen ini:** bisakah agent memindahkan sisa
token/NFT dari dompet korban tanpa korban keluar gas? Dan apakah CLI butuh
dependensi Foundry?

## 1. Jawaban singkat

- **Bisa**, lewat dua jalur (§3 jalur utama yang sederhana, §4 jalur kuat
  untuk kasus balapan dengan drainer). Keduanya memakai pola yang sama
  seperti sekarang: pemilik menandatangani, relayer membayar gas.
- **Foundry TIDAK dibutuhkan sebagai dependensi runtime.** Semua transaksi
  token/NFT adalah panggilan kontrak biasa — wilayah viem
  (`encodeFunctionData`, read/write contract). Foundry tetap alat *lab*:
  (a) verifikasi independen opsional (`cast code`), (b) bila jalur §4 jadi
  dibangun, kontrak RescueDelegate-nya ditulis/diuji dengan forge di
  subproyek terpisah, lalu disebar sekali — CLI hanya butuh alamat + ABI-nya.
  Paket npm harus tetap murni Node + viem supaya `npx` ringan.

## 2. Masalahnya persis di mana

Setelah delegasi dicabut, dompet korban adalah EOA polos — tetapi **kosong**:
tidak ada koin native untuk membayar gas memindahkan sisa token/NFT-nya
(token sisa, NFT yang tidak dilirik drainer, airdrop yang mendarat sesudah
kejadian — di kasus nyata dayu, dompet korban masih memegang token-token
kecil di beberapa chain).

Mengirim koin gas ke dompet yang **masih terdelegasi** adalah jebakan:
deposit apa pun disedot delegate drainer. Jadi urutan dan penjagaannya
adalah inti desain ini — bukan sekadar "tambah perintah transfer".

## 3. Jalur A (utama): cabut → isi debu gas → pemilik memindahkan

Urutan wajib, tidak boleh ditukar:

1. `check` — pastikan status delegasi per chain.
2. `revoke` (sudah ada) — delegasi dicabut via relayer, kode kembali `0x`.
3. `topup` — relayer mengirim debu gas secukupnya ke dompet korban.
   **Pagar keras: perintah ini MENOLAK bila kode target bukan `0x`** (dompet
   masih terdelegasi = memberi makan drainer). Jumlah dibatasi kecil
   (cukup untuk beberapa transfer; pakai panduan float per chain).
4. `send-token` / `send-nft` / sapu native — **ditandatangani dompet korban
   sendiri** (kuncinya, asetnya), gas dari debu langkah 3. Dry-run default;
   pratinjau menampilkan token, jumlah/tokenId, dan alamat tujuan persis.
5. `check` penutup + laporan sisa.

Perintah yang direncanakan:

```bash
agent7702 assets <address> --chain <chain> [--json]
    # inventaris: saldo native + token/NFT yang ditemukan (lihat §5)
agent7702 topup --chain <c> --relayer-file <f> --to <dompet-sudah-bersih> [--amount <debu>]
agent7702 send-token --chain <c> --wallet-file <f> --token <addr> --to <tujuan> (--amount <n> | --all) [--execute]
agent7702 send-nft  --chain <c> --wallet-file <f> --token <addr> --id <tokenId> --to <tujuan> [--execute]
agent7702 rescue --chain <c> --wallet-file <f> --relayer-file <f> --to <dompet-aman> [--execute]
    # orkestrasi jalur A: check -> revoke -> topup -> pindahkan semua yang
    # terdaftar di inventaris (pemilik mengonfirmasi daftar) -> check penutup
```

Dukungan aset v1: native, ERC20 `transfer`, ERC721 `transferFrom`,
ERC1155 `safeTransferFrom`. `--all` membaca saldo on-chain saat pratinjau
dan mengunci angka itu di payload eksekusi (tidak ada kejutan di antaranya).

## 4. Jalur B (lanjutan): RescueDelegate — memanen SEBELUM cabut

**Nama fitur: "Atomic Rescue"** — ditetapkan dayu 2026-10-31 sebagai fitur
unggulan (signature) proyek ini: satu transaksi tipe-4 yang memasang
RescueDelegate DAN mengeksekusi panen secara atomik (otorisasi diproses
sebelum panggilan tx berjalan), sehingga tidak ada celah bagi drainer untuk
menyelip di antara pemasangan dan pemindahan aset.

Ada satu skenario yang tidak bisa diatasi Jalur A: **drainer memegang
otorisasi cadangan** dan memasang ulang delegasinya begitu kita mencabut
(balapan berbulan-bulan di riwayat dompet korban dayu adalah bukti nyata).
Di jendela seperti itu, aset harus keluar *saat* delegasi berada di tangan
kita, bukan sesudahnya.

Pola (fungsi asli 7702 sebagai smart account):

1. `sign-auth` korban → **RescueDelegate**: kontrak minimal milik proyek,
   source terverifikasi, masuk registri known-good. Isinya sengaja sempit:
   satu fungsi `execute(intent, signature)` yang memverifikasi tanda tangan
   PEMILIK atas intent tersebut.
2. Intent ditandatangani pemilik secara off-chain: (chainId, nonce intent,
   kedaluwarsa, daftar aksi). **Daftar aksi dibatasi bentuknya** — hanya
   selector transfer ERC20/ERC721/ERC1155 + transfer native, dengan tujuan
   dan jumlah/tokenId eksplisit per aksi. Tidak ada panggilan bebas.
3. Relayer memanggil `execute` di alamat dompet korban (delegate berjalan
   dalam konteks korban) → aset berpindah ke dompet aman. Gas: relayer.
4. `sign-revoke` ke nol sebagai penutup misi; verifikasi `0x`.

Kontrak ini adalah permukaan serangan baru dan **wajib** diperlakukan
seperti itu: kode minimal, uji forge menyeluruh (replay antar-chain,
kedaluwarsa, nonce intent, selector di luar daftar), audit sebisanya, dan
penyebaran per chain dengan hash bytecode tercatat di registri. Karena itu
Jalur B adalah fase lanjutan, bukan v1.

## 5. Inventaris aset (read-only)

- Sumber utama: API indeks chain (Blockscout per chain terbukti bisa diakses
  dan kaya data token/NFT; dipakai juga saat membedah riwayat korban).
- Cadangan: daftar token yang diberikan operator secara eksplisit
  (`--token` berulang) + pembacaan `balanceOf` langsung via RPC.
- Hasil inventaris selalu *usulan*: pemilik mengonfirmasi daftar sebelum
  `rescue` mengeksekusi. Token tidak dikenal tidak disentuh tanpa persetujuan.

## 6. Prinsip keamanan fitur ini

- **Aset hanya bergerak dengan tanda tangan pemiliknya sendiri** (kunci
  dompet korban untuk Jalur A; intent bertanda tangan untuk Jalur B). Tidak
  ada mode apa pun yang memindahkan aset orang dari kunci relayer.
- **Jangan pernah mendanai dompet terdelegasi** — ditegakkan di kode
  (`topup` memeriksa kode dulu), bukan sekadar peringatan.
- Tujuan penyelamatan ditampilkan mentah + dikonfirmasi per misi; alamat
  tujuan yang ada di registri drainer ditolak.
- Semua perintah baru mengikuti pola lama: dry-run default, `--execute`
  eksplisit, verifikasi on-chain sesudahnya, kunci dari berkas.
- Relayer tetap hanya membayar gas — model float aman tidak berubah.

## 7. Tahapan

1. `assets` (inventaris read-only) + `topup` berpagar + `send-token` /
   `send-nft` — uji Sepolia dengan token/NFT uji.
2. Orkestrasi `rescue` (Jalur A) + SKILL.md diperbarui.
3. (Terpisah, keputusan sendiri) RescueDelegate untuk Jalur B: tulis + uji
   forge, tinjau, sebar ke Sepolia, uji balapan delegasi, baru mainnet.

## 8. Pertanyaan terbuka

- Nama perintah orkestrasi: `rescue`, atau istilah lain?
- Inventaris: cukup Blockscout, atau perlu sumber kedua sejak awal?
- Jalur B dikejar, atau Jalur A saja sudah memenuhi kebutuhan nyata?

## 9. Menu CLI baru yang dibutuhkan (dipetakan dari workflow)

Menu yang sudah ada (tidak berubah): `check`, `sign-revoke`, `revoke`,
`sign-auth`, `delegate`, `submit`, `relayer new|status|sweep|burn`.

**Untuk Jalur A (5 menu):**
```bash
agent7702 assets <address> --chain <c> [--json]                       # inventaris read-only
agent7702 topup --chain <c> --relayer-file <f> --to <dompet-bersih>   # debu gas, menolak target terdelegasi
agent7702 send-token --chain <c> --wallet-file <f> --token <a> --to <t> (--amount <n>|--all) [--execute]
agent7702 send-nft --chain <c> --wallet-file <f> --token <a> --id <n> [--amount <n>] --to <t> [--execute]
agent7702 rescue --chain <c> --wallet-file <f> --relayer-file <f> --to <aman> [--execute]   # orkestrasi Jalur A
```

**Untuk Atomic Rescue / Jalur B (3 menu):**
```bash
agent7702 sign-intent --chain <c> --wallet-file <f> --to <aman> --assets <berkas.json> [--ttl <menit>] [--json]
    # susun + tanda tangani intent penyelamatan (off-chain): daftar aset,
    # tujuan, nonce intent, kedaluwarsa. Mengeluarkan JSON intent bertanda tangan.
agent7702 execute --chain <c> --relayer-file <f> --auth <berkas> --intent <berkas> [--json]
    # TX ATOMIK dari artefak yang sudah ditandatangani: authorizationList =
    # sign-auth ke RescueDelegate + panggilan execute(intent) ke dompet korban.
agent7702 atomic-rescue --chain <c> --wallet-file <f> --relayer-file <f> --to <aman> --assets <berkas.json> [--execute]
    # satu langkah penuh: sign-auth + sign-intent -> execute (atomik) ->
    # sign-revoke + submit (penutup) -> verifikasi check + assets.
```

**Yang TIDAK butuh menu:** penyebaran RescueDelegate (tugas proyek via
forge, sekali per chain; alamatnya cukup tercatat di registri known-good),
dan pemantauan (watchdog yang ada sudah mencakup relayer misi ini).

## 10. Status pembangunan & temuan lapangan (2026-10-31)

**DIBANGUN + TERVERIFIKASI LIVE DI SEPOLIA** (perintah dayu "gass bangun"):
Jalur A (assets/topup/send-token/send-nft/rescue) dan Atomic Rescue
(sign-intent/execute/atomic-rescue) selesai. RescueDelegate
`0x81b00fe94881ccc287d5546e91e88b20042bac6a` di Sepolia; uji forge 7/7
lulus; panen atomik live berhasil dalam SATU tx (`0x39581938…`: 150 MOCK +
4 ERC1155 berpindah, verifikasi cast cocok); intent kedaluwarsa ditolak
on-chain (tx revert, aset tidak bergerak).

Temuan lapangan yang menjadi aturan baku:
1. **Estimasi gas RPC publik tidak dapat diandalkan** (khususnya tx tipe-4
   dan transfer dari akun yang baru dicabut) — semua pengiriman memakai
   batas gas eksplisit; sapu native "all" mengunci maxFee EIP-1559 yang
   sama dengan yang dipakai menghitung sisa.
2. **Tx tipe-4 yang revert TIDAK menggulung balik pemasangan delegasi**
   (terbukti live: intent kedaluwarsa → eksekusi revert, tetapi dompet
   tetap terdelegasi ke RescueDelegate dan nonce otorisasi terpakai).
   Akibatnya: revoke penutup WAJIB sesudah execute yang gagal, dan
   percobaan ulang butuh otorisasi baru (nonce baru). Aman untuk
   RescueDelegate (diam tanpa tanda tangan pemilik); berbahaya bila
   delegate-nya pihak lain — selalu periksa kode dompet sesudah kegagalan.
3. **Rescue Jalur A belum idempoten** untuk aksi ERC20 jumlah-persis:
   menjalankan ulang misi yang setengah selesai dapat mengirim ulang aset
   yang sama. Perbaikan terencana: jurnal misi (catatan aksi yang sudah
   terkonfirmasi per berkas misi) yang dikonsultasikan sebelum pengiriman
   ulang. Sampai itu ada: cek `assets` dulu, sesuaikan daftar aksi.

**Jurnal misi — DIBANGUN + TERVERIFIKASI (2026-10-31, sesi yang sama):**
`rescue` kini menulis `<assets>.journal.json` di samping berkas aset:
identitas misi (chainId/dompet/tujuan), peta aksi-selesai {indeks: txHash,
waktu} yang diperbarui SEGERA sesudah tiap pengiriman terkonfirmasi, dan
penanda sapuan native. Lari ulang melewati aksi yang tercatat; jurnal yang
tidak cocok dengan misi ditolak (fail-closed), `--fresh` memulai misi baru.
Bukti live Sepolia: misi dua aksi sengaja diputus di aksi ke-2 (token
palsu) — jurnal memegang aksi ke-1 (tx `0x67394644…`); sesudah berkas
diperbaiki, lari ke-2 melewati aksi ke-1 dari jurnal dan hanya mengirim
aksi ke-2; saldo akhir cocok persis (total 35 MOCK berpindah, tanpa kirim
ganda), dan uji tujuan-berbeda ditolak oleh validasi jurnal.

## 11. Rancangan: analisis kontrak + Atomic Claim Rescue (2026-10-31)

Latar (kasus nyata pemilik): dompet korban yang terdelegasi ke drainer
kehilangan airdrop ERA (Caldera) — 620,4737 ERA tersapu di Ethereum
2025-10-22 lewat tx ter-relay pada dompet terdelegasi; total kerugian
1.200 ERA. Mekanisme kalahnya: claim mengkreditkan token KE dompet yang
memenuhi syarat, tetapi dompet terdelegasi = kode penyerang yang berkuasa
atas isi dompet; token yang mendarat langsung disapu, dan native apa pun
yang dikirim untuk gas ikut lenyap (jebakan yang sama dengan misi rescue).

### 11.1 `analyze` — analisis kontrak (read-only)
`agent7702 analyze <alamat> --chain <chain> [--wallet <dompet>] [--json]`
- Untuk kontrak delegate: ukuran kode + hash bytecode, kecocokan dengan
  registri drainer yang dikenal (alamat maupun pola bytecode penyapu
  Binance & kasus korban), status verifikasi sumber (Blockscout), dan
  heuristik kemampuan berbahaya dari bytecode (delegatecall, selfdestruct,
  pola sweep transfer massal).
- Untuk kontrak claim/airdrop (dengan --wallet): kelayakan dompet,
  jumlah yang bisa diklaim, sudah diklaim atau belum, gaya claim
  (kredit ke msg.sender vs parameter account), token tujuan, tenggat.
- Semua read-only (eth_call + Blockscout); tidak ada tanda tangan, tidak
  ada pengiriman. Hasil: laporan risiko berbahasa manusia + JSON.

### 11.2 Atomic Claim Rescue — claim yang tidak bisa disambar
Perluasan Atomic Rescue dengan jenis aksi baru di dalam intent: CLAIM.
RescueDelegate v2 mengeksekusi, dari konteks dompet korban sendiri:
(1) memanggil fungsi claim pada kontrak airdrop dengan calldata PERSIS
seperti yang dikomitkan di intent bertanda tangan pemilik (hash calldata
masuk struktur intent — relayer tidak dapat mengganti), lalu
(2) meneruskan SELURUH saldo token hasil claim ke alamat aman.
Satu tx tipe-4: pasang delegate → claim sebagai dompet → teruskan →
(revoke penutup). Tidak ada jendela antar-tx tempat drainer bisa menyela;
token tidak pernah "beristirahat" di dompet yang terdelegasi.
Varian ringan Jalur A bila kontrak claim mendukung klaim-atas-nama dan
dompet bisa dicabut lebih dulu dengan aman: revoke → relayer memanggil
claim → rescue biasa. `analyze` menentukan varian mana yang berlaku.
Batasan v1: bentuk claim MerkleDistributor yang umum
(claim(index, account, amount, proof[])) dan varian claim() untuk diri
sendiri; kontrak claim eksotik menyusul bila ada kasus nyata.
Syarat pembangunan: RescueDelegate v2 + deploy ulang per chain + uji
forge untuk aksi claim (mock distributor) + uji live Sepolia ujung-ke-
ujung sebelum dinyatakan selesai — standar yang sama dengan v1.

### 11.3 Rencana kerja (disetujui arahnya oleh pemilik 2026-10-31)

Fase 0 — Pengintaian claim (`claim-check`, read-only):
- Identifikasi fungsi claim kontrak: ABI terverifikasi (Blockscout) →
  pencocokan selector 4-byte → templat bentuk umum (MerkleDistributor).
- Baca token tujuan, status sudah-diklaim, tenggat; terima berkas alokasi
  (--allocation: index/amount/proof dari data proyek) dan BUKTIKAN lewat
  simulasi eth_call dari konteks dompet sebelum apa pun ditandatangani.
- Keluaran: vonis jalur (A/B), jumlah, dan calldata yang terverifikasi.

Fase 1 — RescueDelegate v2 (aksi CLAIM, kind 4):
- Intent membawa {kontrak claim, token hasil, hash calldata}; execute()
  menerima calldata mentah sebagai parameter dan menolak bila
  keccak-nya tidak sama dengan yang dikomitkan pemilik. Delegate memanggil
  claim dari konteks dompet, lalu meneruskan SELURUH saldo token hasil
  claim ke tujuan. Deploy ulang per chain (Sepolia dulu), registri
  diperbarui; v1 tetap hidup untuk misi transfer murni.

Fase 2 — Perintah CLI:
- `claim-rescue` sekali jalan (sejajar atomic-rescue): sign-auth v2 +
  sign-intent berisi aksi claim → execute → verifikasi jumlah diterima di
  alamat aman → revoke penutup. Dry-run menampilkan dekode panggilan
  claim (nama fungsi + argumen) agar pemilik bisa memeriksa dengan mata
  sebelum tanda tangan.

Fase 3 — Uji berstandar v1:
- Forge: MockDistributor; happy-path claim+forward atomik, proof salah,
  calldata ditukar relayer (hash mismatch → revert), replay, kedaluwarsa.
- Live Sepolia ujung-ke-ujung meniru kasus ERA: dompet uji terdelegasi,
  distributor mock dengan alokasi untuk dompet uji, claim-rescue,
  verifikasi token di alamat aman + dompet bersih.

Fase 4 — Dokumentasi: SKILL.md (alur claim-rescue + claim-check),
DESIGN.md status, templat bentuk claim yang didukung.

Batasan v1 yang disadari: data alokasi/proof berasal dari proyek (berkas),
bukan penarikan otomatis per-proyek; bentuk claim di luar dua pola umum
menyusul bila ada kasus nyata; deploy mainnet per chain = keputusan dan
pendanaan pemilik.

### 11.4 Status pembangunan (2026-10-31) — SELESAI + TERVERIFIKASI LIVE

claim-check dan claim-rescue DIBANGUN sesuai rencana §11.3:
- RescueDelegateV2 di Sepolia: `0x0ed74cc59ecd38fb2bd6f6c8874b9a6f5130efe4`
  (domain EIP-712 versi "2", slot nonce terpisah dari v1). MockDistributor
  gaya OZ di `0x2d4c543826e623a760268252c9e710db7c022444`.
- Forge: 14/14 lulus (7 v1 utuh + 7 v2: claim atomik, calldata ditukar
  relayer, proof salah terisolasi, combo claim+transfer, replay, tanda
  tangan orang lain, jumlah claimDatas salah).
- claim-check live: alokasi benar LOLOS simulasi (templat MerkleDistributor
  menang lewat simulasi karena kontrak tidak terverifikasi di Blockscout);
  alokasi jumlah-salah dilaporkan GAGAL dengan jelas.
- Uji live meniru kasus ERA: dompet uji terdelegasi ke BenignDelegate,
  claim-rescue mengeksekusi tx atomik `0xbc693f97…` — 500 MOCK hasil claim
  tiba di alamat aman (985 → 1485 persis), saldo milik dompet sendiri
  (15 MOCK) tidak tersentuh, isClaimed tercatat, revoke penutup
  mengembalikan kode 0x.
Catatan implementasi: claim-check kini membedakan kegagalan perakitan
parameter vs kegagalan simulasi pada laporannya; berkas alokasi yang
belum lolos simulasi JANGAN ditandatangani (tertulis di SKILL.md).
