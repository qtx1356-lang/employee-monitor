# Employee Monitor (prototype)

A transparent, consent-based monitoring prototype for company-owned or company-managed Windows 10/11 laptops. Intended for a small deployment (10–50 devices) after review by the company's IT, HR, and legal teams.

## Privacy and scope
- Show employees that the agent is installed and running; obtain appropriate notice and authorization.
- Records foreground application process names, heartbeat/online status, and file-system change events in explicitly configured approved work folders.
- File monitoring records the file basename and change type only. It does not read file contents.
- Does not capture keystrokes, screenshots, passwords, clipboard contents, private browser page contents, or personal folders.
- Do not monitor personal devices or folders without a lawful, documented basis.

## Repository layout
- server/: FastAPI API and database.
- agent/: visible Windows agent prototype and configuration.
- dashboard/: simple browser admin dashboard.

## Backend deployment (Render)
1. Create a Web Service from this GitHub repository.
2. Set the Root Directory to server.
3. Build command: pip install -r requirements.txt
4. Start command: uvicorn app:app --host 0.0.0.0 --port $PORT
5. Add environment variables:
   - ADMIN_TOKEN: long random secret, never commit it.
   - ENROLLMENT_CODE: separate long random enrollment secret.
   - DATABASE_URL: managed PostgreSQL connection string for persistent production storage.
6. Deploy and check https://YOUR-SERVICE/health.

SQLite is suitable only for local testing. Use managed PostgreSQL for deployment; do not rely on an ephemeral local disk for production data.

## Agent setup (Windows 10/11)
1. Install Python 3.11 or later.
2. Copy agent/config.example.json to agent/config.json.
3. Set api_base_url, enrollment_code, employee/device names, and approved work folders.
4. From the agent folder run:
   python -m pip install -r requirements.txt
5. Run visibly from a terminal:
   python agent.py
6. The first run enrolls the device and creates device_token.json. Protect this file with Windows account permissions and do not commit it.

## Dashboard
Open dashboard/index.html in a browser. Enter the deployed API URL and the ADMIN_TOKEN value. Keep the admin token private. For production, serve the dashboard over HTTPS and restrict API CORS to its exact origin.

## Current prototype limitations
- No production-grade user accounts, MFA, role-based access, or audit log for administrator actions.
- Admin API uses a single bearer token; replace with proper identity and access management before real employee deployment.
- Application sampling is periodic and records only the foreground process name.
- File-system events detect create/modify/delete/move events in configured folders; they do not prove who opened or read a file.
- No reliable attendance/payroll calculation, Windows service installer, signed installer, auto-update, or offline event queue yet.
- Configure retention, access controls, backup, employee notice, and legal review before production use.

## Local backend test
From server/:
    python -m pip install -r requirements.txt
Set ADMIN_TOKEN and ENROLLMENT_CODE to non-default random values, then run:
    uvicorn app:app --reload

API health check: http://127.0.0.1:8000/health.

Never expose the development defaults to the public internet.
