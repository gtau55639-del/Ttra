# BOTLAUNCH Lokal: jalan di HP, tanpa server, gratis

Semua berjalan di HP kamu lewat Termux. Tidak ada Render, hosting, pinger, atau akun apa pun.
Data bot, env, dan sesi WhatsApp disimpan di folder `~/.botlaunch` di HP.

## Pasang (sekali saja)
1. Pasang **Termux dari F-Droid** (versi Play Store sudah usang).
2. Salin `botlaunch-termux.zip` ke folder Download HP, lalu di Termux ketik satu per satu:

```
termux-setup-storage
pkg install -y unzip
unzip -o ~/storage/downloads/botlaunch-termux.zip -d ~
sh ~/botlaunch-termux/install.sh
```

## Pakai
1. Ketik `botlaunch`. Chrome terbuka di `http://localhost:8787`.
2. Di Chrome: menu ⋮ → **Install app** / **Tambahkan ke layar utama**. Sekarang ada ikon BOTLAUNCH seperti app biasa.
3. Templates → upload ZIP bot → **Analyze** → **Prepare workspace** → My Bots → **Install dependencies** → isi env → **Start bot**.
4. Bot console menampilkan QR WhatsApp. QR tidak bisa discan dari HP yang sama, jadi scan dari HP lain, atau pakai template yang mendukung pairing code (Tautkan dengan nomor telepon).

Server dan Chrome harus bisa jalan bersamaan: biarkan Termux terbuka di latar belakang. Server boleh dimatikan dengan Ctrl+C. Saat `botlaunch` dijalankan lagi, bot yang tadinya jalan menyala sendiri.

## Supaya bot tidak mati sendiri
- Pengaturan HP → Baterai → Termux → **Tanpa batasan**. Di Xiaomi/Oppo/Vivo/Samsung aktifkan juga "autostart" dan kunci Termux di recent apps.
- Jangan tutup notifikasi Termux (itu wakelock yang menjaga CPU tetap hidup).
- Opsional, nyala otomatis saat HP hidup: pasang **Termux:Boot** dari F-Droid, lalu buat `~/.termux/boot/botlaunch.sh` berisi:
  ```
  #!/data/data/com.termux/files/usr/bin/sh
  termux-wake-lock
  botlaunch
  ```

## Backup dan pindah HP
Tombol **Backup** di halaman bot mengunduh zip ke Download Chrome. Isinya workspace + sesi WhatsApp (tanpa `node_modules` dan tanpa nilai env). Untuk memulihkan di HP baru: upload zip itu sebagai template, lalu isi env lagi. Sesi WhatsApp ikut, jadi tidak perlu scan ulang.

## Batasan
- Hanya bot Node.js. Python belum didukung (sama seperti dashboard aslinya).
- Template `whatsapp-web.js` butuh Chromium, di HP pakai template Baileys.
- Modul native (`sharp`, `canvas`, `better-sqlite3`, ...) bisa gagal karena install memakai `--ignore-scripts`.
- Android bisa mematikan Termux di HP tertentu meskipun sudah diatur di atas.
- App APK lama tidak dipakai di mode ini (hanya mau konek ke alamat https). Pakai Chrome/PWA seperti di atas.

## Keamanan
Server hanya mendengarkan `127.0.0.1` (bukan jaringan WiFi). Request dari situs web lain ke server ini ditolak (cek Host, Origin, Sec-Fetch-Site). Bot adalah kode dari ZIP yang kamu upload dan bisa membaca file Termux kamu; jalankan hanya template yang kamu percaya. Untuk menambah kunci, jalankan dengan `BOTLAUNCH_TOKEN=rahasia-panjang botlaunch`, dan dashboard akan meminta token.

## Lokasi penting
- Data: `~/.botlaunch/projects/<id>/` (`app/` workspace, `env.json`, `run.log`)
- Backup: `~/.botlaunch/backups/`
- Program: `~/botlaunch/` (jalankan `install.sh` lagi untuk update; data tidak tersentuh)
