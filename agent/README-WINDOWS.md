# Windows 10/11 agent setup

This is a visible, manually started prototype for company-managed Windows 10 and Windows 11 devices. Use it only with documented employee notice and authorization.

## 1. Prepare the configuration

1. Install Python 3.11 or newer from https://www.python.org/downloads/windows/.
2. During setup, enable **Add Python to PATH**.
3. Copy `config.example.json` to a new file named `config.json` in this same folder.
4. Edit `config.json`:
   - `api_base_url`: `https://employee-monitor.s16530460.workers.dev`
   - `enrollment_code`: the exact `ENROLLMENT_CODE` Worker secret value (do not share it or commit `config.json`)
   - `device_name`: a unique company asset name, e.g. `OFFICE-PC-01`
   - `employee_name`: the assigned employee's name
   - `approved_work_folders`: only specifically approved company work folders; remove the sample path if it is not used
5. Keep `config.json` and `device_token.json` private. They contain credentials.

## 2. Start the agent

Double-click `run-agent.bat`. On first run it installs the required Python packages and starts the visible agent. The first successful run registers the device. Keep the console window open while testing; press Ctrl+C or close the window to stop it.

## 3. Verify

Open https://employee-monitor.s16530460.workers.dev/ and refresh the Devices section. The device should appear after enrollment and heartbeat.

## Data collected

- Device name and employee name supplied in config
- Foreground application process name, sampled at the configured interval
- File-system event type and file basename only inside explicitly configured approved work folders
- Heartbeat timestamps

It does not capture keystrokes, screenshots, passwords, browser page contents, or document contents. File-system notifications are metadata and do not prove that a person opened or read a file. The agent is not hidden and does not install itself as a service or configure automatic startup.

## Important security notes

- Never put `ADMIN_TOKEN` in the agent config. The agent needs only the separate `ENROLLMENT_CODE`; the Worker issues a per-device token.
- Never commit `config.json` or `device_token.json` to GitHub. Add them to `.gitignore` if you use Git locally.
- Use unique device names. A device name can be enrolled only once; if enrollment already happened, keep its `device_token.json` safe for future runs.
- This is a prototype, not production-ready employee-management software. Before company-wide rollout, add identity-based administration, MFA, audit logs, retention limits, backup/recovery, signed updates, and HR/legal review.
