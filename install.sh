#!/data/data/com.termux/files/usr/bin/sh
# Pemasang BOTLAUNCH Lokal untuk Termux. Aman dijalankan ulang (data di ~/.botlaunch tidak disentuh).
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
PREFIX="${PREFIX:-/data/data/com.termux/files/usr}"
TARGET="$HOME/botlaunch"

echo "== BOTLAUNCH Lokal: memasang =="
pkg update -y >/dev/null 2>&1 || true
pkg install -y nodejs unzip zip

if ! node -e 'process.exit(parseInt(process.versions.node) >= 18 ? 0 : 1)'; then
  echo "Node.js terlalu lama (butuh 18+). Jalankan: pkg upgrade -y"; exit 1
fi

if [ "$DIR" != "$TARGET" ]; then
  mkdir -p "$TARGET"
  rm -rf "$TARGET/public"
  cp -r "$DIR/server.js" "$DIR/public" "$TARGET/"
fi

cat > "$PREFIX/bin/botlaunch" <<'LAUNCH'
#!/data/data/com.termux/files/usr/bin/sh
# Menjalankan BOTLAUNCH Lokal. Wakelock menjaga HP tidak tidur supaya bot tetap online.
command -v termux-wake-lock >/dev/null 2>&1 && termux-wake-lock
cd "$HOME/botlaunch" || { echo "Folder ~/botlaunch tidak ada. Jalankan install.sh lagi."; exit 1; }
URL="http://localhost:${PORT:-8787}"
if [ -t 1 ] && command -v termux-open-url >/dev/null 2>&1; then
  ( sleep 2; termux-open-url "$URL" ) &
fi
exec node server.js
LAUNCH
chmod +x "$PREFIX/bin/botlaunch"

echo ""
echo "Selesai. Jalankan dengan mengetik:  botlaunch"
echo "Lalu buka http://localhost:8787 di Chrome."
