# checker_validator

Validator email Xfinity (Express + Puppeteer) — **crash-safe** (v1.1).

## Perbaikan vs versi lama

| Masalah lama | Perbaikan |
|---|---|
| `page.waitForNavigation` timeout karena login Xfinity SPA → **unhandled rejection → proses mati** | Polling deteksi hasil (`#passwd` muncul = SUCCESS, teks error = FAILED, Akamai = FORBIDDEN) |
| Handler Express async tanpa try/catch → error mematikan seluruh server | Try/catch + error middleware + `unhandledRejection`/`uncaughtException` handler (proses tidak pernah mati) |
| `user-agents` tidak terinstall di setup.sh → `MODULE_NOT_FOUND` | `package.json` lengkap, `npm install` sekali jalan |
| Banyak request paralel → Chrome berlebihan → OOM | Pembatas konkurensi (default 2, atur `MAX_CONCURRENT`) |
| Chrome tidak ada / path salah | Deteksi otomatis: `CHROME_PATH` → `/usr/bin/google-chrome` → `/usr/bin/chromium` → bawaan puppeteer |

## Install (satu perintah)

```bash
bash setup.sh
```

Atau manual:

```bash
npm install
npm install -g pm2
pm2 start checker3.js --name checker3
pm2 save
```

## Penggunaan

```bash
curl 'http://IP_VPS:3000/validator?email=user@comcast.net'
# -> {"email":"user@comcast.net","status":"SUCCESS","detail":"password step reached"}
```

Status:
- `SUCCESS`   → akun terdaftar (muncul form password) → tersimpan di `valid.txt`
- `FAILED`    → "We don't recognize that Xfinity ID" → `bad.txt`
- `FORBIDDEN` → diblokir Akamai/captcha (ganti IP/proxy) → `forbidden.txt`
- `ERROR`     → error teknis → `bad.txt`
- `UNKNOWN`   → hasil tidak jelas (lihat `detail`) → `unknown.txt`

Health check & dashboard:
```bash
curl http://IP_VPS:3000/status     # {"ok":true,...}
curl http://IP_VPS:3000/monitor    # dashboard realtime
```

## Variabel lingkungan opsional

```bash
PORT=3000                     # port server
CHROME_PATH=/usr/bin/chromium # lokasi Chrome (otomatis jika tidak diisi)
MAX_CONCURRENT=2              # maks pengecekan paralel
LOGIN_URL=https://login.xfinity.com/login
OUT_DIR=/path/ke/hasil        # folder valid.txt/bad.txt (default: folder skrip)
```

## Catatan

- Server **tidak akan mati** walau request gagal — kalau masih `errored` di PM2,
  cek `pm2 logs checker3` untuk error saat startup (biasanya Chrome belum terinstall).
- IP datacenter sering diblokir Akamai → status `FORBIDDEN`. Gunakan proxy
  residensial atau IP rumah untuk hasil maksimal.
