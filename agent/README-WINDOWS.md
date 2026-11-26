# Windows 10/11 agent setup (standalone build)

This visible monitoring agent is for authorized company-managed Windows devices. Provide employee notice and follow applicable workplace/privacy rules.

## Install with automatic startup (recommended)

1. Download the latest successful **Build Windows Agent** artifact named `employee-monitor-windows` from the repository's GitHub **Actions** tab.
2. Extract the complete ZIP to a normal folder.
3. Double-click `install-agent.bat` and approve the Windows administrator prompt.
4. On first run, the installer creates `config.json` and opens it in Notepad. Enter the assigned employee name, save, close Notepad, then run `install-agent.bat` again.
5. The installer copies the agent to `C:\ProgramData\EmployeeMonitor` and registers two visible, named Windows Scheduled Tasks:
   - `EmployeeMonitor-BootHeartbeat`: starts at Windows boot as SYSTEM and sends heartbeat requests only. It does not inspect the desktop or applications.
   - `EmployeeMonitor-UserSession`: starts at the configured employee's Windows logon in that user's desktop session and detects foreground application process names.
6. Both tasks are configured to restart after a failure. You do not need to open `run-agent.bat` each day.

The boot component can report the computer online before an employee signs in, once the device has been approved and the network is available. Foreground application detection begins only after the configured user signs in. If another Windows account uses this PC, rerun the installer while signed in to that account or have an administrator configure its logon task too.

## Approve the computer

1. Open the admin dashboard.
2. Find the computer under **Pending device approvals**.
3. Verify the employee and device identity, then click **Approve**.
4. The boot and user-session components will send heartbeats automatically. No manual restart should be required, though restarting the tasks after approval is a useful first test.

## Check or stop the agent

- Open **Task Scheduler** and look for `EmployeeMonitor-BootHeartbeat` and `EmployeeMonitor-UserSession`.
- To stop temporarily, open Task Scheduler, right-click each task and choose **End**. To start again, choose **Run**.
- To remove automatic startup, right-click each task and choose **Delete**, or run `uninstall-agent.ps1` as Administrator from the installed folder. This leaves the installed files and device registration in place.
- To run manually for troubleshooting, use `run-agent.bat` from the extracted package only after stopping the scheduled user-session task, to avoid running two foreground monitors at once.

## Data collected

- Device name detected from Windows and employee name supplied in config
- Foreground application process name, sampled every 5 seconds by default; only changes are sent, after user logon
- File-system event type and file basename only inside explicitly configured approved work folders
- Heartbeat timestamps

It does not capture window titles, keystrokes, screenshots, passwords, browser page contents, or document contents. File-system notifications are metadata and do not prove that a person opened or read a file. The boot heartbeat component sends no application or file activity.

## Credential and deployment notes

- The employee config does not need the admin token.
- Keep `config.json` and `device_token.json` private; the latter contains the device credential.
- This is a prototype, not production-ready employee-management software. Before company-wide rollout, add identity-based administration, MFA, audit logs, retention limits, backup/recovery, signed updates, rate limiting, and HR/legal review.
