# Kilat — Pengingat Utang Warung via WhatsApp

**Kilat** adalah aplikasi PWA *offline-first* berbahasa Indonesia untuk pemilik warung dan toko kelontong: buku kasbon digital (piutang pelanggan **dan** hutang ke supplier), pemantau risiko keterlambatan (`Tinggi` / `Sedang` / `Rendah`), jatuh tempo, pengingat WhatsApp dalam 3 nada (`Sopan`, `Singkat`, `Tegas`) + template sendiri (Pro), kartu ringkasan dan bukti pembayaran `1080×1350` PNG, statistik, foto bon, QRIS terlampir, multi-warung (Pro), dan cadangan cloud terenkripsi (Pro+, opsional).

**Aturan keras:** Kilat tidak pernah menyimpan, memindahkan, atau meminta uang. Semua pembayaran terjadi langsung antara warung dan pelanggan/supplier; Kilat hanya mencatat.

- **Package ID (TWA):** `com.sakredstudio.kilat`
- **Penyimpanan lokal:** `localStorage` key `kilat.v1` (`schemaVersion: 2`, lihat *Skema data*), foto bon dan QRIS di IndexedDB `kilat-photos`.
- **Privasi:** 100% lokal di perangkat, tanpa akun, tanpa pelacakan. Satu-satunya fitur yang menyentuh server adalah cadangan cloud terenkripsi (Pro+, opt-in, mati secara bawaan, belum diaktifkan di rilis ini).
- Tanpa *build step*, tanpa dependensi, tanpa CDN. Vanilla JS ES modules.

## Menjalankan secara lokal

```bash
npx serve projects/kilat/app
```

## Pengujian

```bash
node --test projects/kilat/app/tests/*.test.mjs
```

Setiap modul murni di `lib/` punya berkas uji di `tests/`. `tests/acceptance.test.mjs` menjalankan alur lengkap (12 pelanggan + 20 utang + jatuh tempo + pengingat beruntun + buku supplier + 2 warung + cadangan JSON) dan memverifikasi daftar precache `sw.js` terhadap berkas di disk serta ketiadaan CDN.

## Layar & fitur

### v1 (dasar)
1. **Atur Toko (`setup`)** — nama warung, pemilik, nomor WhatsApp, jatuh tempo default (7/14/30 hari).
2. **Daftar Pelanggan (`list`)** — total piutang, jumlah perlu ditagih, pencarian, chip risiko, batas 25 pelanggan di versi gratis.
3. **Rincian Pelanggan (`detail`)** — sisa utang, riwayat, `+ Tambah Utang`, `✓ Catat Bayar` (FIFO ke utang tertua), *undo* 5 detik.
4. **Kirim Pengingat (`reminder`)** — 3 nada, pratinjau gelembung WhatsApp, teks dapat diedit, tautan `wa.me`, baris `— Kilat · https://kilat.sakredstudio.ca` selalu ditambahkan (`lib/wa.js` yang menjaminnya).
5. **Kartu Ringkasan (`card`)** — PNG `1080×1350`, Web Share API / unduh, watermark di versi gratis.
6. **Pengaturan (`settings`)** — nada default, bahasa (ID/EN), mode gelap, data contoh (opt-in, tidak pernah otomatis), ekspor/impor JSON, CSV (Pro), hapus semua, privasi.

### v2 — "minggu warung"
- **Jatuh tempo** (`lib/ledger.js`, `lib/wa.js`) — setiap utang punya `dueDate` opsional (bawaan: tanggal + jatuh tempo default; kosongkan di lembar tambah utang untuk tanpa tenggat). Bagian **"Hari ini"** di atas daftar menampilkan pelanggan yang jatuh tempo hari ini atau sudah lewat tenggat (mengikuti FIFO: lunasi utang tertua, tenggat berikutnya yang dipakai). Ini terpisah dari risiko umur utang. Variabel template ke-4 `{tanggal}`; bila ada tenggat, ketiga nada memakai varian yang menyebut tanggalnya.
- **Kelola pelanggan** (`lib/store.js`) — hapus pelanggan (konfirmasi + *undo* 5 detik), **gabungkan** dua pelanggan (utang, bayar, dan jurnal pengingat pindah; kedua nomor WhatsApp disimpan di catatan), deteksi **nomor ganda** saat menambah (buka yang ada / tetap simpan).
- **Pengingat beruntun** (`lib/broadcast.js`) — tombol *"Kirim ke semua yang nunggak (N)"* membuka antrean yang berjalan satu per satu (risiko tertinggi dulu, lalu hari, lalu saldo): pratinjau, *Kirim WhatsApp*, *Berikutnya* (lewati atau setelah terkirim), progres N/M, ringkasan di akhir. Setiap kiriman (beruntun maupun tunggal) dicatat ke `reminders[]` `{customerId, sentAt, tone, book}`; rincian pelanggan menampilkan *"Terakhir diingatkan"*. Pola ini meniru loop *next pending* di Chanda Collector.
- **Bukti pembayaran** (`lib/receipt-card.js`, `lib/canvas-share.js`) — setelah mencatat bayar, spanduk *"Kirim bukti"* membuat kartu PNG `1080×1350` *"LUNAS"* / *"Sisa Rp X"* (sisa dihitung per pembayaran itu), dibagikan via Web Share dengan fallback unduh, plus opsi teks saja ke `wa.me`; tiap baris pembayaran di riwayat bisa membuka buktinya lagi. Watermark di versi gratis. Kartu menyatakan jelas bahwa pembayaran terjadi di warung.
- **Catatan foto** (`lib/photos.js`) — satu foto per utang (bon tulisan tangan), diambil dari kamera/galeri di lembar tambah utang atau dilampirkan dari baris riwayat, diperkecil di HP ke maks. 800 px (JPEG), disimpan sebagai dataURL di **IndexedDB** (bukan `localStorage`), *thumbnail* di baris, penampil layar penuh dengan hapus. Foto ikut di ekspor/impor JSON (kunci `photos`) dan terhapus oleh *Hapus Semua Data*. Saat pelanggan dihapus, fotonya baru dibersihkan setelah jendela *undo* 5 detik berakhir.
- **Template sendiri (Pro)** — Pengaturan → *Template pengingat sendiri*: chip variabel `{nama} {jumlah} {hari} {warung} {tanggal}`, pratinjau langsung, simpan, reset ke bawaan. Muncul sebagai nada ke-4 *"Sendiri"* di layar pengingat tunggal dan beruntun. Versi gratis melihat gerbang Pro. Baris `— Kilat` tetap ditambahkan.
- **Statistik** (`lib/stats.js`) — dari ikon 📊 di header daftar atau dari Pengaturan: piutang per minggu (8 minggu terakhir, batang `div`, minggu mulai Senin), 5 penunggak terbesar, pembayaran dicatat bulan ini vs bulan lalu (+ delta %), jumlah pengingat bulan ini.

### v3 — "sisi supplier"
- **Buku hutang supplier** (`lib/store.js` `BOOKS`, `lib/ledger.js` `bookView`) — sakelar **Piutang (pelanggan) | Hutang (supplier)** di atas daftar. Buku supplier memakai bentuk data yang sama (`suppliers[]`, `supplierDebts[]`, `supplierPayments[]`; demi reuse mesin ledger, id supplier pada catatan hutang/bayar tetap di kolom `customerId`). Rincian supplier memakai renderer yang sama; pengingat di sini adalah **"Ingatkan saya"** (rencana bayar: tanggal + catatan untuk diri sendiri) dan **"Kabari supplier"** (pesan WhatsApp bernada sopan saja: kapan warung berencana membayar). Tidak ada gabung/bukti pembayaran di buku supplier. Batas 25 di versi gratis hanya untuk pelanggan.
- **Multi-warung (Pro)** (`lib/books.js`) — `schemaVersion: 2`: `{ books: [ {id, warung, customers, debts, payments, suppliers, supplierDebts, supplierPayments, reminders} ], activeBookId, settings }`. `migrate()` membungkus data v1 sebagai `books[0]` tanpa kehilangan apa pun. Seluruh kode membaca buku aktif lewat `activeBook(state)`. Nama warung di header membuka lembar pemilih: pindah, tambah (gratis 1, Pro hingga 5; warung baru mewarisi pemilik/nomor/jatuh tempo lalu membuka layar Atur Toko), hapus (konfirmasi + *undo*, tidak bisa menghapus warung terakhir). Cadangan JSON memuat semua warung; impor menerima v1 maupun v2.
- **QRIS** (`lib/qris.js`) — Pengaturan → unggah gambar QRIS statis warung (IndexedDB, kunci `qris:<bookId>`, maks. 1000 px, bisa dihapus). Layar pengingat pelanggan menampilkan sakelar **"+ Lampirkan QRIS"**: pratinjau menambah baris *"Bisa scan QRIS warung di gambar terlampir ya, pembayaran langsung ke warung 🙏"*, dan tombol kirim memakai **Web Share API** (teks + berkas gambar). Bila Web Share tidak tersedia: tautan `wa.me` teks dibuka seperti biasa, gambar diunduh ke HP, dan aplikasi menjelaskan *"kirim gambar ini di WhatsApp"*. Catatan jujur: PWA tidak bisa memasukkan gambar langsung ke `wa.me`, jadi fallback dua langkah ini adalah versi paling dekat yang bisa dilakukan. Tidak ada uang yang lewat Kilat.
- **Cadangan cloud terenkripsi (Pro+)** (`lib/cloud.js`, `projects/kilat/worker/`) — opsional, **mati secara bawaan**. Di HP: PBKDF2 (200.000 iterasi, SHA-256) dari kata sandi + salt acak → kunci AES-GCM-256 → mengenkripsi seluruh JSON cadangan (semua warung; foto bon tidak ikut agar di bawah batas 1 MB). Pengenal satu-satunya adalah `vaultId` acak 16 byte (32 heks). Unggah/unduh via `fetch(CLOUD_URL + '/v1/vault/' + vaultId)` PUT/GET dengan `{salt, iv, data, updatedAt}` base64. `CLOUD_URL` di `lib/cloud.js` bernilai `''` = belum dikonfigurasi, dan UI menampilkan *"Belum tersedia"*. Pengaturan → *Cadangan cloud (Pro+)*: buat brankas (menampilkan kode brankas + aturan kata sandi), pulihkan di HP baru (kode + kata sandi), waktu cadangan terakhir, sakelar cadangan otomatis setelah perubahan (debounce 30 detik; kata sandi diminta sekali per sesi dan hanya disimpan di memori), putuskan brankas, hapus cadangan di cloud. Kata sandi tidak pernah disimpan atau dikirim. **Catatan jujur:** belum ada SKU langganan "Pro+" di Play Billing (`lib/billing.js` tidak disentuh); gerbangnya saat ini memakai `isPro`. Server (`worker/`) adalah Cloudflare Worker + D1 (`wrangler.toml` dengan binding `DB`, `schema.sql`, `src/index.js`: PUT/GET/DELETE, batas 1 MB, CORS untuk `https://sakredstudio.github.io`, 60 permintaan/menit per IP, tanpa auth selain id yang tidak bisa ditebak) dan **belum di-deploy**.

## Skema data (`localStorage` `kilat.v1`, `schemaVersion: 2`)

```
{ schemaVersion: 2,
  books: [ { id, warung: {name, ownerName, phone, currency, dueDays},
             customers: [{id, name, phoneRaw, phone62, note, createdAt}],
             debts:     [{id, customerId, amountIdr, note, date, dueDate|null}],
             payments:  [{id, customerId, amountIdr, date, note}],
             suppliers, supplierDebts, supplierPayments   // bentuk sama; supplier punya payPlan? {date, note}
             reminders: [{id, customerId, sentAt, tone, book: 'customer'|'supplier'}] } ],
  activeBookId,
  settings: { tone, isPro, lang, darkMode, hasCompletedSetup, customTemplate,
              cloud: { vaultId, autoBackup, lastBackupAt } } }
```

Foto bon (`<debtId>`) dan QRIS (`qris:<bookId>`) ada di IndexedDB `kilat-photos`, object store `photos`.

## Modul `lib/`

| Modul | Isi |
|---|---|
| `store.js` | persistensi, `migrate()` v1→v2, buku aktif, undo, seed, ekspor/impor, CSV, `onStateSaved` |
| `books.js` | `activeBook()`, batas warung (gratis 1 / Pro 5) |
| `ledger.js` | saldo FIFO, risiko umur, jatuh tempo (`dueBuckets`), `bookView` |
| `wa.js` | template 3 nada (+ varian `{tanggal}`), template supplier, baris `— Kilat`, tautan `wa.me` |
| `broadcast.js` | antrean pengingat beruntun, jurnal terakhir diingatkan |
| `share-card.js`, `receipt-card.js`, `canvas-share.js` | kartu ringkasan & bukti pembayaran, berbagi/unduh PNG |
| `photos.js` | IndexedDB foto bon + QRIS, pengecil gambar |
| `stats.js` | statistik mingguan/bulanan |
| `qris.js` | muatan berbagi teks + gambar QRIS |
| `cloud.js` | enkripsi cadangan + klien brankas |
| `billing.js` | Play Billing Kilat Pro (tidak diubah) |
| `i18n.js`, `format.js`, `phone.js` | bahasa, Rupiah/tanggal, normalisasi nomor |

## Deploy (GitHub Pages)

Live at https://kilat.sakredstudio.ca/. The public repo `SakredStudio/kilat` is a deploy mirror of this folder; the monorepo is the source of truth. From the sakred-os root, on master:

```
git subtree push --prefix=projects/kilat/app https://github.com/SakredStudio/kilat.git main
```

The workflow in `.github/workflows/deploy.yml` runs the tests and publishes the folder. Bump `CACHE_NAME` in `sw.js` first (v4 = v2/v3 feature release).

### Worker (belum di-deploy)

```
cd projects/kilat/worker
npx wrangler d1 execute kilat-vault --file=schema.sql --remote
npx wrangler deploy
```

Lalu isi `CLOUD_URL` di `app/lib/cloud.js`, bump `CACHE_NAME`, dan deploy ulang aplikasi.
