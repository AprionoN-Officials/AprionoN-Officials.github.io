# 🖼️ AprionoN Officials — PNG Render Repository

## Mengelola katalog website

Tambahkan PNG ke `Render 2.0/Nama Series/Nama Karakter/`, lalu commit ke branch `root`. Deployment membuat ulang katalog dari file Git yang tersedia; tidak perlu menambahkan path gambar satu per satu ke `index.json`. Tanggal terbaru mengikuti commit terakhir yang mengubah file tersebut. Katalog hasil build ada di artifact deployment, bukan commit tambahan pada branch.

Untuk membuat katalog secara lokal, gunakan Node.js 22 dan jalankan `node scripts/build-catalog.cjs`. Jalankan pemeriksaan dengan `node --test tests/*.test.cjs`. Repository harus memiliki riwayat Git lengkap agar tanggal akurat. Pemetaan kover khusus tetap dikelola melalui `covers` di `index.json`; path kover yang hilang akan menghentikan deployment.

Galeri menggunakan preview WebP dari wsrv.nl. Tautan **Download PNG Original** membuka file PNG asli pada GitHub; tergantung browser, file dapat terbuka sebelum disimpan. Ukuran original ditampilkan di samping tautan. Jika layanan preview gagal, tautan original tetap tersedia.

Repository ini digunakan untuk **menyimpan, mengelola, dan menampilkan hasil render gambar dalam format PNG**.
Gambar yang tersedia di repository ini dapat digunakan sebagai **preview, asset, atau sumber gambar** untuk berbagai kebutuhan.

## ✨ Preview

Berikut adalah beberapa contoh hasil render yang tersedia di repository ini:

<p align="center">
  <img src="Render 2.0/Arknights EndField/Fluorite/1.png" width="300">
</p>


## 📁 Isi Repository

Repository ini terutama berisi:

* 🖼️ Render gambar PNG
* 🎨 Asset hasil rendering
* 📷 Gambar dengan kualitas tinggi
* 📦 File PNG yang dapat digunakan sebagai asset
* 🌐 File yang dapat diakses melalui GitHub Pages

## 🖼️ Format

Format utama yang digunakan:

| Format          | Keterangan                                         |
| --------------- | -------------------------------------------------- |
| PNG             | Format utama untuk hasil render                    |
| Transparansi    | Dapat digunakan jika gambar memiliki alpha channel |
| High Resolution | Menyesuaikan resolusi hasil render                 |


## ⚠️ Catatan

Repository ini ditujukan untuk **penyimpanan dan distribusi hasil render/gambar PNG**.

Ukuran file dan jumlah asset dapat memengaruhi penggunaan storage serta bandwidth GitHub.

---

### 👤 AprionoN Officials

[GitHub Repository](https://github.com/AprionoN-Officials/AprionoN-Officials.github.io?utm_source=chatgpt.com)

**PNG Render & Image Repository**
