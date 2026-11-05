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

## 12. Rancangan: Relay-Call — panggilan kontrak umum berpagar (2026-10-31)

### 12.1 Keputusan & motivasi

**DISETUJUI dayu 2026-10-31 ~21:37 WIB.** Dayu menilai contract-call adalah menu penting dan mengusulkan versi relayer-nya; agen menyetujui nilainya dengan syarat bentuknya khas agent-7702 — bukan contract-call bebas ala wallet umum (BAW), melainkan generalisasi Atomic Claim Rescue (§11): panggilan berjalan **sebagai wallet korban**, gas dibayar relayer, dan isi panggilan terkunci oleh tanda tangan pemilik.

Motivasi: claim-rescue §11 hanya mencakup pola klaim yang umum. Fungsi kustom — klaim non-standar, unstake, withdraw, interaksi kontrak penyelamatan lain — tidak tercakup templat. Wallet korban tidak dapat membiayai gas sendiri (koin native apa pun yang masuk disapu delegasi drainer), jadi panggilan harus menumpang tx tipe-4.

### 12.2 Bentuk perintah

- **`call-check`** (read-only): rekognisi + simulasi satu panggilan (target + calldata) dari alamat wallet; mengeluarkan ringkasan risiko dan status simulasi. Tanpa tanda tangan, tanpa kunci.
- **`relay-call`** (misi atomik satu tembakan, pola claim-rescue): rakit intent → pemilik menandatangani → relayer mengirim tx tipe-4 (pasang RescueDelegateV3 + execute) → verifikasi hasil on-chain → revoke penutup.

### 12.3 Mekanisme (RescueDelegateV3)

- Kontrak baru **RescueDelegateV3**: domain EIP-712 "Agent7702Rescue" versi **"3"**, slot nonce intent terpisah dari v1/v2. Aksi baru **kind 5 = CALL** {target, callHash, forwardTokens[]}.
- Intent mengomit: wallet, alamat aman tujuan (`to`), target, **value — terkunci 0**, `callHash = keccak256(calldata)`, daftar `forwardTokens`, nonce, expiry (maksimum 1 jam).
- Eksekusi: delegate memverifikasi `keccak256(calldata) == callHash` (selisih → aksi gagal, nol bergerak — relayer tidak dapat mengganti isi panggilan), memanggil target **sebagai wallet** dengan value 0, mengukur saldo sebelum/sesudah untuk koin native dan setiap token di `forwardTokens`, lalu meneruskan **GAIN saja** ke `to`. Saldo lama wallet tidak disentuh.
- Fakta protokol §10/§11 berlaku penuh: tx tipe-4 yang revert TIDAK membatalkan instalasi delegasi → **revoke penutup wajib**; percobaan ulang butuh intent + otorisasi baru.

### 12.4 Pagar (tidak dapat ditawar)

1. **Simulasi dulu, selalu**: `call-check` menjalankan eth_call calldata persis dari alamat wallet; hasil revert = jangan ditandatangani.
2. **Target**: wajib kontrak ter-deploy, bukan alamat di registri drainer, bukan wallet itu sendiri, bukan RescueDelegate.
3. **Selector tolak keras** (kebutuhan ini dilayani perintah khusus, dan approve tidak punya tempat dalam misi penyelamatan): `approve` 0x095ea7b3, `setApprovalForAll` 0xa22cb465, `increaseAllowance` 0x39509351, `transfer` 0xa9059cbb, `transferFrom` 0x23b872dd, `safeTransferFrom` 0x42842e0e/0xb88d4fde.
4. **Selector tak dikenal**: dekode via ABI terverifikasi (Blockscout) bila ada, selain itu basis data 4-byte; tetap dilabeli `TIDAK DIKENAL` dan hanya berjalan setelah simulasi lolos + konfirmasi eksplisit pemilik (pola sign-auth).
5. **Value terkunci 0** di v1 — panggilan payable di luar cakupan.
6. **Hasil hanya ke `to`** yang terkomit di intent; tidak ada penerima lain yang dapat disisipkan relayer.

### 12.5 Batasan v1

- Satu panggilan per misi (tanpa batch; banyak aksi adalah pengembangan lanjutan).
- Penerusan hasil: koin native + ERC-20 yang didaftarkan di `forwardTokens`. NFT atau token lain yang dihasilkan panggilan tetap di wallet untuk misi berikutnya (perilaku sama seperti token non-hadiah di V2).
- Simulasi eth_call mendekati semantik "sebagai wallet" untuk mayoritas fungsi klaim/unstake; perbedaan state yang bergantung pada kode delegasi yang terpasang tidak dapat ditangkap simulasi — karena itu verifikasi pasca-eksekusi atas gain aktual bersifat wajib, bukan opsional.
- Mainnet menunggu deployment V3 per chain atas keputusan + pendanaan dayu (pola V1/V2).

**Status: DIBANGUN + DIBUKTIKAN LIVE DI SEPOLIA 2026-10-31 ~21:50 WIB.** RescueDelegateV3 tersebar di `0xdF057afC121D0c4c29255a86992d924fD334a8C4`; target uji MockExoticVault (fungsi eksotik `releaseVested()` membayar 250 token + 0,01 ETH ke pemanggil, sekali per alamat) di `0x2609b1F47E1D6d0B657a9F98CEdA4450D92FFC4a`; berkas `contracts/sepolia-deployment-v3.json`. Uji forge gabungan 23/23 LULUS (v1 7 + v2 7 + v3 9: panen atomik token+native, calldata tertukar gagal, daftar penerus tertukar gagal, target revert terisolasi, gain token tak terdaftar tetap di dompet, replay & tanda tangan asing ditolak, jumlah data salah ditolak). Bukti live: call-check menolak calldata `approve` (DITOLAK, alasan terekam) dan meloloskan `releaseVested()`; wallet uji w1-v2 didelegasikan ke BenignDelegate lalu relay-call mengeksekusi — tx atomik `0x2d40a310…` meneruskan persis +250 MOCK dan +0,01 ETH ke alamat tujuan, saldo milik wallet sendiri (15 MOCK) utuh, revoke penutup `0xe911120d…` menyembuhkan ke `0x`. Belum diterbitkan ke npm (menunggu keputusan versi/terbit dayu; kandidat minor berikutnya).


## §13 Smart Wallet Batch — BatchCallDelegationV2 (2026-11-01)

### 13.1 Keputusan arsitektur (pemilik)

- Perintah **`batch`** adalah SATU-SATUNYA metode eksekusi smart wallet di CLI. Tidak ada keluarga menu turunan (kirim/claim/call terpisah): semua kemampuan adalah template penyusun `Call[]` yang masuk ke satu pipa yang sama — susun → tanda tangan EIP-712 → simulasi → relayer kirim → verifikasi.
- Berbeda dari RescueDelegate (misi korban satu tembakan, selalu ditutup revoke): delegate ini **persisten** — dompet menjadi smart account yang tetap terpasang sampai pemilik mencabutnya lewat `revoke` biasa.
- `relay-call` TIDAK dilipat ke `batch` pada rilis ini: semantiknya berbeda (penerusan GAIN dinamis untuk hasil yang jumlahnya belum diketahui sebelum eksekusi tidak dapat diwakili batch yang mengomit jumlah di muka). Batch mencakup semua kasus yang jumlahnya diketahui saat tanda tangan.

### 13.2 Kontrak

- **BatchCallDelegationV2** (`contracts/src/BatchCallDelegationV2.sol`): jalur mandiri `execute` (hanya akun sendiri) + jalur relayer `executeSigned` (tanda tangan EIP-712 domain "BatchCallDelegation" versi "2", terikat akun + chain, atas calls + nonce + deadline); nonce anti-replay di storage bernama ERC-7201 (bertahan melewati cabut/pasang ulang); larangan self-target; kunci anti-reentrancy; ERC-1271 `isValidSignature` diverifikasi ke kunci akun.
- Lahir dari hardening pola BatchCallDelegation tanpa autentikasi (spesimen yang diunggah pemilik): pintu masuk tanpa tanda tangan dihapus total; permit ERC-2612 bukan jalur terpisah — ia hanyalah call biasa di dalam batch bertanda tangan.
- Uji forge 11/11 (suite gabungan 34/34). Sepolia: `0x1591DdA47F3b34a3441d8a4213C1bB51401108a8` (tx deploy `0xeaba9c08…`), berkas `contracts/sepolia-deployment-batch.json`; tercatat di registri known-good.

### 13.3 Bentuk perintah

- `batch --chain <chain> --wallet-file <f>` dengan template `--send`, `--send-token`, `--send-token-raw`, `--send-nft`, `--send-1155`, `--call`, atau `--calls <file.json>` untuk batch campuran (mis. claim lalu teruskan). Opsi: `--ttl` menit (bawaan 30), `--batch-nonce` (wajib benar bila akun pernah memakai delegate lalu mencabutnya), `--install` (sematkan otorisasi pemasangan ke intent), `--sign-only`, `--intent <file>` untuk eksekusi terpisah, `--execute --relayer-file <f>`. Tanpa `--execute` selalu pratinjau.
- Dua mode eksekusi: (A) delegate sudah terpasang → relayer mengirim tx biasa; (B) `--install` → SATU tx tipe-4 memasang delegate dan langsung mengeksekusi batch (`submitAuthorization` digeneralisasi untuk membawa calldata + batas gas dinamis; perilaku bawaannya identik).

### 13.4 Pagar

1. Digest hitungan CLI **disalib-periksa** ke `getDigest()` on-chain setiap kali delegate terpasang; ketidakcocokan = berhenti sebelum tanda tangan.
2. **Simulasi wajib** sebelum kirim di kedua mode; mode tipe-4 disimulasikan utuh dengan authorizationList. Batch yang akan revert tidak pernah dikirim.
3. Nonce basi / replay intent yang sudah terkonsumsi **ditolak di CLI** sebelum transaksi dibuat; deadline intent diperiksa terhadap waktu rantai.
4. Delegasi asing tidak pernah ditimpa oleh mode batch; target self di dalam batch ditolak sejak penyusunan.
5. Total nilai native batch tidak boleh melebihi saldo akun; selector sensitif (approve, setApprovalForAll, increaseAllowance, transferFrom, safeTransferFrom, permit) selalu tampil sebagai peringatan di pratinjau.
6. Preflight float relayer mengikuti model yang sama dengan jalur lain.

### 13.5 Bukti live (Sepolia, 2026-11-01)

- Pra-CLI (skrip tangan): kirim native bertanda tangan; kirim ERC20 dalam satu tx tipe-4; klaim 300 MOCK dari distributor baru lalu teruskan ke alamat aman dalam satu tx tipe-4 (`0x70a08ef2…`) — saldo ETH akun identik sebelum/sesudah di semua uji.
- Lewat perintah `batch` itu sendiri: mode `--install` klaim 200 MOCK + teruskan ke funder (tx `0x6e12d365…`, nonce batch 3→4); mode terpasang kirim 2 MOCK (tx `0x8b487fda…`, nonce 4→5, nonce dibaca otomatis); intent terpisah `--sign-only` → `--intent` (tx `0x91d23628…`, nonce 5→6, digest terverifikasi on-chain); replay intent yang sama **ditolak** ("intent basi"); `check` menampilkan `[BatchCallDelegationV2 — nonce batch N]`; `revoke` menutup dengan dompet uji bersih (`0x`).

**Status: DIBANGUN + DIBUKTIKAN LIVE DI SEPOLIA 2026-11-01.** Kelanjutan tercatat: paket 0.5.0 DITERBITKAN ke npm 2026-11-03, dan BatchCallDelegationV2 DIPASANG DI MAINNET BSC 2026-11-04 via CREATE2 (alamat `0x40417919600bc4819B975a09992938a409495934`, salt `keccak256("BATCHCALLDELEGATION-V2")`; berkas `contracts/mainnet-deployment-batch.json`).

## §14 RescueDelegateV4 + pelipatan CLI `mission` (2026-11-04)

### 14.1 Keputusan & motivasi

**DIBANGUN atas persetujuan dayu 2026-11-04** (opsi "bangun V4 beneran" + perintah menyederhanakan CLI agar tidak redundan). Temuan pemicu: RescueDelegateV3 sebenarnya SUDAH merupakan gabungan V1+V2+V3 (satu intent dapat mencampur kind 0–5), jadi "V4 gabungan" murni akan redundan. Satu-satunya kemampuan yang benar-benar belum ada di seluruh keluarga: **panggilan bernilai (value call)** — §12.5 butir 5 mengunci value = 0 di V3, padahal ada kasus penyelamatan klasik yang mewajibkan pembayaran persis dari dompet (bayar biaya unlock/tebusan, repay untuk membuka agunan, fungsi fee-gated lain). V4 = V3 + kemampuan itu; sekaligus permukaan CLI dilipat menjadi satu alur misi terpadu.

### 14.2 Kontrak — RescueDelegateV4

- Delta minimal dari V3: struct `Action` menambah field terakhir `uint256 value`; typehash EIP-712 Action diperbarui; domain "Agent7702Rescue" versi **"4"**; slot penanda nonce terpisah (`agent7702.rescue.v4.usedNonces`). Tanpa owner/admin/pause/upgrade; tanpa dependensi baru.
- Semantik value: hanya kind 5. Panggilan berjalan dengan value PERSIS `a.value` wei dari saldo dompet sendiri — terkomit di tanda tangan, tidak dapat diubah relayer (diubah = BadSignature). Untuk kind 0–4 field diabaikan (kind 4 tetap penerusan gain murni).
- Penerusan gain native dihitung BERSIH: garis dasar = saldo awal − value terkomit; hanya kenaikan di atas garis dasar itu yang diteruskan ke `to`. Value adalah biaya yang dikomitkan pemilik, BUKAN diambil dari gain penerusan.
- Saldo tidak cukup untuk value → panggilan gagal → ActionFailed terisolasi, misi berlanjut (pagar yang sama seperti kegagalan target lain). Calldata/daftar penerus tetap terkomit hash persis seperti V3.
- Runtime 6.597 byte — jauh di bawah batas EIP-170 BSC (24.576).

### 14.3 Pelipatan CLI — perintah `mission`

- Satu perintah terpadu menggantikan tiga alur paralel untuk misi BARU: `agent7702 mission --chain <c> --wallet-file <f> --relayer-file <f> --to <aman> --assets <mission.json> [--ttl] [--execute]`. Berkas misi = `{actions:[...]}` yang sama, kini mendukung semua kind termasuk claim (kind 4), call (kind 5), dan value kind 5.
- Disiplin tidak berubah: selector terlarang (approve, increaseAllowance, setApprovalForAll, transfer, transferFrom, safeTransferFrom) ditolak di lapisan penyusun intent (`buildIntentV4`) sebelum tanda tangan; SETIAP panggilan kind 4/5 wajib lolos simulasi eth_call dari alamat dompet (`simulateMissionCalls`) atau misi dibatalkan — termasuk untuk dry-run; lalu pola lama berlaku: sign-auth → sign-intent → tx tipe-4 atomik → revoke penutup → laporan gain terverifikasi di tujuan.
- Registri `RESCUE_DELEGATES_V4` di `lib/rescue.mjs` dikunci per chainId; perintah menolak bersih di chain tanpa delegate v4 terdaftar. Mainnet SENGAJA kosong.
- Perintah lama (`atomic-rescue`, `claim-rescue`, `relay-call`, `sign-intent`, `execute`, `call-check`, `claim-check`, Jalur A, `batch`) TIDAK dihapus dan tetap berfungsi untuk Sepolia V1–V3; di SKILL.md ketiganya ditandai legacy/Sepolia dan `mission` didokumentasikan sebagai jalur penyelamatan utama.

### 14.4 Status pembangunan (2026-11-04)

- Forge: suite gabungan **51/51 LULUS** (34 lama utuh + 17 baru V4: seluruh cakupan relay-call v3, claim atomik + calldata ditukar, kedaluwarsa, dan lima uji value — value persis terkomit, value melebihi saldo terisolasi, value diubah sesudah tanda tangan → BadSignature, value 0 = perilaku persis V3, value call dengan hash calldata tidak cocok → value tidak keluar).
- Gladi bersih anvil ujung-ke-ujung: **12/12 pemeriksaan lulus** — misi campuran (claim 500 MOCK diteruskan + value call buyUnlock 0,05 ETH persis dengan payout 300 MOCK diteruskan + sweep 100 MOCK) dalam SATU tx tipe-4 (gasUsed 301.170), saldo native dompet berkurang hanya sebesar value terkomit, revoke penutup mengembalikan kode 0x. Lari pertama gladi (dompet uji tak berdana) sekaligus membuktikan isolasi kegagalan value pada alur nyata: aksi value gagal sendiri, claim + sweep tetap selesai.
- Deploy Sepolia TERTUNDA pendanaan deployer bersama `0xd31AF7…8065`: estimasi deploy terukur (eth_estimateGas atas initcode persis) **10.493.470 gas** — pada gas price live (~32 wei) biayanya ~0,0000003 ETH, tetapi saldo deployer 0,0000983 ETH tidak memberi margin aman terhadap lonjakan fee (pada harga perencanaan 2 gwei deploy saja = 0,020987 ETH; kekurangan terhadap saldo ≈ **0,0209 ETH**, dan seluruh rangkaian Part 4 ≈ 0,03 ETH — sesuai top-up yang sudah diminta ke dayu). Sesudah top-up tiba: deploy via forge create → verifikasi on-chain → isi registri Sepolia + known-good → `contracts/sepolia-deployment-v4.json` → uji live satu misi campuran (claim + acceptAny bernilai kecil + sweep) lewat perintah `mission` itu sendiri.

- **Status akhir (2026-11-05):** rangkaian Part 4 di atas SELESAI — RescueDelegateV4 live di Sepolia 2026-11-04 (`0x759bcEFaF488CcbD652f6114a8bddCd6D4440464`, misi campuran live lolos) dan **live di MAINNET BSC 2026-11-05** (`0x23c35334fd72302C6A58e379591d9c2F0833709D`, deploy via BAW → pabrik CREATE2, salt `keccak256("RESCUEDELEGATE-V4")`, gasUsed 1.482.995, bytecode on-chain cocok persis dengan artefak; berkas `contracts/mainnet-deployment-v4.json`). Terdaftar di `RESCUE_DELEGATES_V4[56]` + known-good pada gelombang yang sama; dibawa rilis npm 0.6.0 bersama alamat Batch BSC.
