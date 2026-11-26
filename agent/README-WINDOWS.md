# Windows 10/11 agent setup (standalone build)

This is a visible, manually started prototype for company-managed Windows 10 and Windows 11 devices. Use it only with documented employee notice and authorization.

## Install on an employee computer (no Python required)

1. Download the latest successful **Build Windows Agent** artifact named `employee-monitor-windows` from the repository's GitHub **Actions** tab.
2. Extract the ZIP to a normal folder.
3. Double-click `run-agent.bat`.
4. On first run, the launcher creates `config.json` and opens it in Notepad.
5. Edit only `employee_name` with the assigned employee's name. The computer name is detected automatically. The Worker URL and sample approved folder are already configured.
6. Save and close Notepad, then double-click `run-agent.bat` again.
7. Keep the console window open. The device submits a registration request and waits for administrator approval.

## Approve the computer

1. Open the admin dashboard and load it with the administrator token.
2. Find the computer under **Pending device approvals**.
3. Confirm the employee and device identity, then click **Approve**.
4. Restart the agent on that computer. It will then send heartbeats and permitted activity metadata.

A public registration endpoint means anyone who knows the dashboard URL could submit a request. Therefore, new devices are inactive until an administrator verifies and approves them. Review pending requests before approval.

## Data collected

- Device name detected from Windows and employee name supplied in config
- Foreground application process name, sampled every 5 seconds by default; only changes are sent
- File-system event type and file basename only inside explicitly configured approved work folders
- Heartbeat timestamps

It does not capture window titles, keystrokes, screenshots, passwords, browser page contents, or document contents. The foreground application is identified through the Windows foreground-window and process-ID APIs. File-system notifications are metadata and do not prove that a person opened or read a file. The agent is not hidden and does not install itself as a service or configure automatic startup.

## Credential and deployment notes

- The employee config no longer needs the enrollment code or admin token.
- Keep `config.json` and `device_token.json` private; the latter contains the device credential.
- This is a prototype, not production-ready employee-management software. Before company-wide rollout, add identity-based administration, MFA, audit logs, retention limits, backup/recovery, signed updates, rate limiting, and HR/legal review.

## Phase 1 application detection test

1. Stop any older agent instance.
2. Download the newest successful Build Windows Agent artifact and extract it to a new folder.
3. Start the agent using `run-agent.bat` (not the EXE directly for first-run setup).
4. Confirm the device is approved and the agent heartbeat succeeds.
5. Open Chrome, then switch to Edge or Excel. Leave each application in the foreground for at least 10 seconds.
6. Refresh Recent activity in the dashboard. You should see process names such as `chrome.exe`, `msedge.exe`, or `EXCEL.EXE` when those apps are foreground.

The agent deliberately does not collect window titles or webpage/document text. The foreground process can be missed briefly if an application is only foreground for less than the sampling interval.
