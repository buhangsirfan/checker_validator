#!/bin/bash
# =====================================================================
# Setup checker_validator di VPS (Ubuntu/Debian x86_64)
# Jalankan:  bash setup.sh
# Hasil: server checker3.js jalan di port 3000 via PM2
# =====================================================================

echo "==> [1/7] Update sistem"
sudo apt update
sudo apt -y upgrade

echo "==> [2/7] Install Node.js (NodeSource current)"
curl -fsSL https://deb.nodesource.com/setup_current.x | sudo -E bash -
sudo apt-get install -y nodejs

echo "==> [3/7] Install library sistem yang dibutuhkan Chrome"
sudo apt-get install -y libnss3 libatk-bridge2.0-0 libx11-xcb1 libxcomposite1 \
  libxdamage1 libxrandr2 libgbm1 libasound2 libpangocairo-1.0-0 libgtk-3-0

echo "==> [4/7] Install Google Chrome"
if command -v google-chrome >/dev/null 2>&1; then
  echo "    google-chrome sudah terpasang, dilewati."
else
  wget -q https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb -O /tmp/chrome.deb
  sudo dpkg -i /tmp/chrome.deb || sudo apt --fix-broken install -y
  rm -f /tmp/chrome.deb
  if ! command -v google-chrome >/dev/null 2>&1; then
    echo "    [fallback] Chrome .deb gagal, coba unduh via puppeteer..."
    npx puppeteer browsers install chrome
  fi
fi

echo "==> [5/7] Install dependensi npm (dari package.json)"
npm install

echo "==> [6/7] Install PM2"
sudo npm install -g pm2

echo "==> [7/7] Jalankan checker3.js dengan PM2 (auto-restart jika crash)"
pm2 start checker3.js --name checker3 || pm2 restart checker3
pm2 save
pm2 startup

echo ""
echo "=============================================================="
echo " Selesai. Cek status:"
echo "   pm2 status"
echo "   pm2 logs checker3"
echo "   curl http://localhost:3000/status"
echo "   curl 'http://localhost:3000/validator?email=contoh@comcast.net'"
echo "=============================================================="
