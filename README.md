# Kilat — Pengingat Utang Warung via WhatsApp

**Kilat** adalah aplikasi PWA *offline-first* berbahasa Indonesia untuk pemilik warung dan toko kelontong guna mencatat utang pelanggan (buku kasbon digital), memantau risiko keterlambatan (`Tinggi` / `Sedang` / `Rendah`), mengirim pengingat WhatsApp dalam 3 nada (`Sopan`, `Singkat`, `Tegas`), dan membagikan Kartu Ringkasan Piutang (`1080×1350` PNG).

- **Package ID (TWA Proposal):** `com.sakredstudio.kilat`
- **Penyimpanan Lokal:** `localStorage` key `kilat.v1` (`schemaVersion: 1`)
- **Privasi:** 100% lokal di perangkat (`Data tersimpan di HP ini`), tanpa akun, tanpa server eksternal.

## Menjalankan Secara Lokal

```bash
npx serve projects/kilat/app
```

## Menjalankan Pengujian Unit & Acceptance

```bash
node --test projects/kilat/app/tests/*.test.mjs
```

## Daftar Layar & Fitur

1. **Atur Toko (`Setup`):** Nama warung, nama pemilik, nomor WhatsApp, mata uang (`IDR`), jatuh tempo default (`7`/`14`/`30` hari), dan pratinjau pesan otomatis.
2. **Daftar Pelanggan (`List`):** Bar ringkasan Total Piutang & jumlah pelanggan perlu ditagih, pencarian instan, chip filter risiko (`Semua`, `🔴 Tinggi`, `🟡 Sedang`, `🟢 Rendah`), dan batas versi gratis 25 pelanggan (Pro tanpa batas).
3. **Rincian Pelanggan (`Detail`):** Sisa utang, total utang & dibayar, riwayat kronologis (`Utang` & `Bayar`), *bottom sheet* `+ Tambah Utang` dan `✓ Catat Bayar` (termasuk tombol 1-ketuk `Lunasi Semua`), serta *toast* `Urungkan` (Undo) selama 5 detik.
4. **Kirim Pengingat (`Reminder`):** Pilihan 3 nada (`🙏 Sopan`, `⚡ Singkat`, `📢 Tegas`), pratinjau gelembung chat WhatsApp, kotak teks yang dapat diedit, dan tautan `wa.me/62...` dengan baris atribusi `— Kilat · https://sakred.in/kilat`.
5. **Kartu Ringkasan (`Share Card`):** Merender kartu laporan gelap `1080×1350` piksel ke `<canvas>` berisi total piutang dan 3 penunggak tertinggi, dibagikan melalui Web Share API (`navigator.share({ files })`) atau unduhan berkas PNG.
6. **Pengaturan (`Settings`):** Nada default, Mode Gelap, pemuat data contoh (6 atau 12 pelanggan), ekspor/impor cadangan JSON, ekspor laporan CSV (Pro), dan halaman Kebijakan Privasi (`privacy.html`).
