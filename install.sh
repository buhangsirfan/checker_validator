# Daftar perintah yang ingin dijalankan
echo "Check update...."
sudo apt update

echo "Melakukan upgrade...."
sudo apt -y upgrade

echo "Menginstal Library yang diperlukan"
sudo apt install -y libnss3 libatk-bridge2.0-0 libx11-xcb1 libxcomposite1 libxdamage1 libxrandr2 libgbm1 libasound2 libpangocairo-1.0-0 libgtk-3-0

echo "Download chrome"
wget https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb

echo "Install chrome"
sudo dpkg -i google-chrome-stable_current_amd64.deb

echo "Fix proken installer"
sudo apt --fix-broken install -y

echo "Install Puppeteer"
npm i puppeteer

echo "Plugin puppeteer stealth"
npm install puppeteer-extra puppeteer-extra-plugin-stealth

echo "Install express sebagai webserver"
npm install express