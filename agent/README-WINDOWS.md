# Windows 10/11 agent setup (standalone build)

This is a visible, manually started prototype for company-managed Windows 10 and Windows 11 devices. Use it only with documented employee notice and authorization.

## Install on an employee computer (no Python required)

1. Download the **Windows standalone agent** ZIP from the latest successful **Build Windows Agent** workflow run in the GitHub repository's Actions tab.
2. Extract the ZIP to a normal folder, for example `C:\\CompanyTools\\EmployeeMonitor`.
3. Double-click `run-agent.bat`.
4. On the first run, the launcher creates `config.json` and opens it in Notepad. Fill in:
   - `api_base_url`: `https://employee-monitor.s16530460.workers.dev`
   - `enrollment_code`: the exact `ENROLLMENT_CODE` Worker secret value (do not share it or commit `config.json`)
   - `device_name`: a unique company asset name, e.g. `OFFICE-PC-01`
   - `employee_name`: the assigned employee's name
   - `approved_work_folders`: only specifically approved company work folders; remove the sample path if it is not used
5. Save and close Notepad, then double-click `run-agent.bat` again.
6. Keep the console window open while testing. Press Ctrl+C or close the window to stop the agent.

**Python is not required on employee computers.** The standalone Windows build bundles the Python runtime and required libraries. Only the build machine/GitHub Actions needs Python to create the executable.

## Where to get the standalone ZIP

In GitHub, open the repository's **Actions** tab, select the latest successful **Build Windows Agent** run, and download the artifact named `employee-monitor-windows`. The ZIP contains the executable, launcher, example configuration, and this guide.

## Verify

Open https://employee-monitor.s16530460.workers.dev/ and refresh the Devices section. The device should appear after enrollment and heartbeat.

## Data collected

- Device name and employee name supplied in config
- Foreground application process name, sampled at the configured interval
- File-system event type and file basename only inside explicitly configured approved work folders
- Heartbeat timestamps

It does not capture keystrokes, screenshots, passwords, browser page contents, or document contents. File-system notifications are metadata and do not prove that a person opened or read a file. The agent is not hidden and does not install itself as a service or configure automatic startup.

## Credential and deployment notes

- Never put `ADMIN_TOKEN` in the agent config. The agent needs only the separate `ENROLLMENT_CODE`; the Worker issues a per-device token.
- Never commit `config.json` or `device_token.json` to GitHub. They contain credentials.
- Keep `config.json` and `device_token.json` private and restrict access to the employee/device administrator.
- Use unique device names. If enrollment already happened, keep that device's `device_token.json` safe for future runs.
- This is a prototype, not production-ready employee-management software. Before company-wide rollout, add identity-based administration, MFA, audit logs, retention limits, backup/recovery, signed updates, and HR/legal review.
