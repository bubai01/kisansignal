# KisanSignal

KisanSignal is an installable farmer-focused PWA served by an Express API. The existing HTML/CSS/JavaScript frontend is preserved. Production data is stored in PostgreSQL (Neon works directly); the old SQLite file is retained only as an optional migration source.

## Local setup

Requirements: Node.js 20+ and a PostgreSQL database.

```powershell
Copy-Item .env.example .env
npm install
```

Set at least `DATABASE_URL`, `SECRET`, and `ADMIN_TOKEN` in `.env`. For a local smoke test, `SMS_PROVIDER=console` and `ALLOW_DEV_OTP=1` expose a code in the response; never enable that in production.

```powershell
npm start
npm test
```

The app is at `http://localhost:3000`, health is `/api/health`, and the admin dashboard is `/admin`.

## PostgreSQL and SQLite migration

Startup applies [server/schema.sql](server/schema.sql) idempotently and checks the database connection. Neon URLs should use SSL; the default pool configuration uses `rejectUnauthorized=false` because Neon presents a managed certificate. Set `PGSSL=disable` only for a trusted local database.

To copy an existing SQLite database without deleting or modifying it:

```powershell
$env:DATABASE_URL = "postgresql://..."
npm run migrate:sqlite -- .\data\kisansignal.db
```

The importer transfers all seven tables (`users`, `otps`, `sessions`, `fields`, `alert_log`, `events`, `advisor_log`) in one transaction and repairs PostgreSQL sequences.

## Railway + Neon

1. Create a Neon project and copy its pooled connection string.
2. Push this folder to GitHub.
3. In Railway, choose **New Project > Deploy from GitHub Repo**, select `bubai01/kisansignal`, and approve repository access.
4. Railway reads [railway.json](railway.json), runs `npm ci`, starts `npm start`, and checks `/api/health`.
5. Add `DATABASE_URL`, `SECRET`, and `ADMIN_TOKEN` in Railway Variables. Add SMS/AI variables only when those providers are configured.
6. Generate a Railway public domain, then open the HTTPS URL and verify `/api/health`.

Railway is the requested non-Render option, but its free/trial credits and pricing are subject to change and may require billing verification; do not assume unlimited permanent free hosting. Neon Free has storage, compute, connection, and transfer quotas; keep the pool small and use Neon's pooled URL. Neither service is a substitute for backups. The app does not require a persistent disk.

The existing [render.yaml](render.yaml) remains available as a second deployment path if Railway is not suitable.

## Environment variables

See [.env.example](.env.example). Important values:

- `DATABASE_URL`, `PG_POOL_MAX`, `PGSSL`: PostgreSQL connection.
- `SECRET`, `ADMIN_TOKEN`, `TRUST_PROXY`: production security and Render proxy behavior.
- `SMS_PROVIDER=twilio|msg91|console` plus the provider credentials.
- `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL`, `ADVISOR_PER_DAY`: optional advisor.
- `ALERTS_ENABLED`, thresholds, interval, and `MAX_ALERTS_PER_RUN`: alert scheduler/cost controls.

SMS/WhatsApp delivery requires a Twilio or MSG91 account, approved sender/templates, and provider credentials. The app reports provider failures; it does not fake successful delivery. The Anthropic advisor remains disabled until its key is configured.

## Android

Use Chrome on Android to open the deployed **HTTPS** URL, then choose **Install app / Add to Home screen**. The manifest, icons, responsive layout, and service worker are already included. API calls are same-origin, so no frontend secret is exposed.

No Capacitor project is included because the requested PWA path does not require changing the frontend and an APK has not been built or tested. If a standalone APK is later needed, wrap the deployed HTTPS origin with Capacitor, add Android tooling, and validate login, cookies, notifications, and offline behavior on a physical device before release.

## Testing and limitations

`npm test` is the existing end-to-end smoke suite adapted to the configured PostgreSQL database. It requires a reachable `DATABASE_URL`; it does not claim delivery through live SMS/WhatsApp, Anthropic, Render, Neon, HTTPS, or a physical Android device. Those integrations require the operator's accounts and credentials.
