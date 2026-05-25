# WBF · EBL Registration Form

Static HTML form + Vercel serverless function that stores submissions in Postgres and photographs in Vercel Blob storage. Accessible from China (no Google services, `*.vercel.app` domains are reachable).

## File structure

```
wbf-ebl-form/
├── index.html          # the public form (/)
├── admin.html          # password-protected admin panel (/admin)
├── api/
│   ├── register.js     # /api/register  — receives submissions
│   └── export.js       # /api/export    — returns all rows (auth required)
├── package.json        # dependencies
└── schema.sql          # database schema (run once)
```

## Deploy in 5 steps

### 1. Push to GitHub
Create a new repo on GitHub, upload these files, push to `main`.

### 2. Import the repo on Vercel
- Go to https://vercel.com/new
- Import the GitHub repo
- Framework preset: **Other** (it's a plain static site + API)
- Click **Deploy**

The site goes live at `https://your-project.vercel.app`. The form will be visible but submissions will fail until you finish steps 3–4.

### 3. Add a Postgres database
- In your Vercel project → **Storage** tab → **Create Database**
- Choose **Neon** (or any Postgres option) → Continue
- After creation, click **Connect Project** → it auto-injects `POSTGRES_URL` env var
- Open the database's **Query** tab and paste the contents of `schema.sql`, run it

### 4. Add Blob storage
- Same **Storage** tab → **Create Store** → **Blob**
- Connect to your project → it auto-injects `BLOB_READ_WRITE_TOKEN`

### 5. Redeploy
- Deployments tab → click ⋯ on the latest deployment → **Redeploy**
  (this picks up the new env vars)

Done. The form now writes to your database.

## Set the admin password

Before the admin panel works you must set one environment variable on Vercel:

- Project → **Settings** → **Environment Variables**
- Add: `ADMIN_PASSWORD` = (a password you choose)
- Apply to: Production + Preview + Development
- Redeploy so the new variable takes effect

## Viewing & exporting submissions

Open **`https://your-project.vercel.app/admin`**, enter the password, and you get:

- A live table of all registrations in the exact column order
  *(Family name · Given name · Gender · Country of Birth · Country of Residence · Date of Birth · E-mail · Phone · National affiliation code · Photo · Chinese name)*
- A search box that filters across all columns
- **`Copy for Google Sheets`** button — copies all (or all filtered) rows as TSV.
  Open your Google Sheet, click cell A1, paste — every column lands in the right place automatically.
- **`Download CSV`** button — UTF-8 with BOM, so Chinese names render correctly in Excel as well.
- Photo column shows a thumbnail that links to the full-size image on Vercel Blob.

For direct SQL access (custom queries / analytics), Vercel dashboard → Storage → your DB → Query tab.

## China accessibility

- No Google Fonts, no Google reCAPTCHA, no `googleapis.com` calls
- System fonts only (renders Chinese via PingFang SC / Microsoft YaHei)
- Static page + `/api/register` both served from `*.vercel.app` (reachable from China without VPN)
- Postgres/Blob calls are server-to-server (China user → Vercel edge → DB)

If you later want a Chinese-mainland-hosted custom domain, point a CNAME from your domain (registered with Aliyun/Tencent) to `cname.vercel-dns.com`.

## Costs

Vercel free tier covers:
- 100 GB-hours of serverless function execution / month
- 1 GB Blob storage + 10 GB bandwidth / month
- Neon free tier: 0.5 GB Postgres storage, 100h compute

More than enough for a federation registration form.

## Validation rules enforced

- **Family name / Given name**: only `A–Z a–z space ' - .` — no accents, no Cyrillic, no Chinese
- **E-mail**: standard format
- **Phone**: must start with `+` or a digit, min 6 chars
- **Photo**: JPG / PNG / WEBP, max 4 MB
- **Chinese name**: optional, accepts any characters
- All checks run **both** client-side (immediate feedback) **and** server-side (security)
