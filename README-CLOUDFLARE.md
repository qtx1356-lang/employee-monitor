# Cloudflare deployment (migration branch)

This branch adds a Cloudflare Workers + D1 deployment while keeping the existing Render backend and Windows agent files unchanged. It is a parallel migration: do not remove Render until Cloudflare has been tested.

## Cloudflare resources
- Workers: API and static admin dashboard
- D1: persistent device and activity database
- Worker secrets: ADMIN_TOKEN and ENROLLMENT_CODE
- Static assets: public/index.html

## Deploy
1. In Cloudflare Dashboard, create a D1 database named `employee-monitor-db`.
2. Copy its database ID into `wrangler.toml`, replacing `REPLACE_WITH_YOUR_D1_DATABASE_ID`.
3. Install Node.js on your computer, clone this repository, and check out branch `cloudflare-migration`.
4. From the repository folder run:
   ```sh
   npm install
   npx wrangler login
   npx wrangler d1 migrations apply employee-monitor-db --remote
   ```
5. Add Worker secrets (never commit or share their values):
   ```sh
   npx wrangler secret put ADMIN_TOKEN
   npx wrangler secret put ENROLLMENT_CODE
   ```
   Use two different, randomly generated secrets, each at least 24 characters.
6. Deploy:
   ```sh
   npm run deploy
   ```
7. Check `https://YOUR-WORKER.workers.dev/health`. It should report `{"status":"ok","version":"1.0.0-cloudflare","database":"connected"}`.
8. Open the Worker URL. The dashboard fills its API URL automatically. Enter the same ADMIN_TOKEN you configured as a Worker secret.

## Windows agent
The current `agent/agent.py` uses the same endpoints and request headers, so it can use the Cloudflare Worker URL as `api_base_url` in `agent/config.json`. Set the same ENROLLMENT_CODE as the Worker secret. Do not enroll company laptops until the health check and dashboard have been verified.

## Important
- Cloudflare D1 is SQLite-compatible; this Worker uses parameterized D1 queries.
- Keep Render running during migration. The D1 database starts empty; existing Render/PostgreSQL records are not copied automatically.
- Do not paste ADMIN_TOKEN, ENROLLMENT_CODE, or device tokens into chat or commit them to Git.
- This remains a prototype with one shared admin bearer token. Add identity-based admin login, MFA, audit logs, retention controls, backups, and HR/legal review before real employee deployment.
- Monitoring must be transparent, authorized, and limited to company-managed devices and approved work folders. This agent records process names and file event metadata only; it does not prove that a file was opened or read.
