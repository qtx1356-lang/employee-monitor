"""
Single-file Windows setup for Employee Monitor.
Installs the visible agent and creates named, user-visible scheduled tasks.
"""
import ctypes
import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
import tkinter as tk
from tkinter import messagebox, simpledialog

APP = "EmployeeMonitor"
INSTALL = Path(os.environ.get("ProgramData", r"C:\ProgramData")) / APP
LOGS = Path(os.environ.get("LOCALAPPDATA", str(INSTALL))) / APP / "logs"

def is_admin():
    try:
        return bool(ctypes.windll.shell32.IsUserAnAdmin())
    except Exception:
        return False

def relaunch_admin():
    params = subprocess.list2cmdline(sys.argv)
    rc = ctypes.windll.shell32.ShellExecuteW(None, "runas", sys.executable, params, None, 1)
    if rc <= 32:
        raise RuntimeError("Windows administrator approval was not completed.")
    raise SystemExit(0)

def main():
    root = tk.Tk()
    root.withdraw()
    root.attributes("-topmost", True)
    if not is_admin():
        relaunch_admin()

    payload = Path(getattr(sys, "_MEIPASS", Path(sys.executable).parent)) / "payload" / "EmployeeMonitorAgent.exe"
    if not payload.exists():
        messagebox.showerror("Employee Monitor setup", "The agent component is missing from this installer.")
        return

    INSTALL.mkdir(parents=True, exist_ok=True)
    LOGS.mkdir(parents=True, exist_ok=True)
    exe = INSTALL / "EmployeeMonitorAgent.exe"
    shutil.copy2(payload, exe)

    config_path = INSTALL / "config.json"
    if not config_path.exists():
        config = {
            "employee_name": "",
            "approved_work_folders": [r"C:\Users\Public\Documents\CompanyWork"],
            "heartbeat_seconds": 60,
            "app_sample_seconds": 5,
            "idle_threshold_minutes": 10
        }
        config_path.write_text(json.dumps(config, indent=2), encoding="utf-8")

    try:
        config = json.loads(config_path.read_text(encoding="utf-8"))
    except Exception:
        messagebox.showerror("Employee Monitor setup", "The existing config.json is invalid. Please ask your administrator to repair it.")
        return

    if not config.get("employee_name") or config.get("employee_name") == "Enter Employee Name":
        employee = simpledialog.askstring("Employee Monitor setup", "Enter the employee name assigned to this computer:", parent=root)
        if not employee or not employee.strip():
            messagebox.showwarning("Employee Monitor setup", "Setup cancelled. An employee name is required.")
            return
        config["employee_name"] = employee.strip()
        config_path.write_text(json.dumps(config, indent=2), encoding="utf-8")

    # Preserve the already-approved device token, if it exists in the prior install.
    # The agent itself will request enrollment if no token is present.
    token_path = INSTALL / "device_token.json"
    if not token_path.exists():
        old_locations = [
            Path(os.environ.get("ProgramData", r"C:\ProgramData")) / "EmployeeMonitor" / "device_token.json",
            Path.home() / "EmployeeMonitor" / "device_token.json"
        ]
        for old in old_locations:
            if old.exists() and old.resolve() != token_path.resolve():
                shutil.copy2(old, token_path)
                break

    ps = r'''
$ErrorActionPreference = "Stop"
$exe = "__EXE__"
$root = "__ROOT__"
$currentUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$settings = New-ScheduledTaskSettingsSet -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -StartWhenAvailable

$bootAction = New-ScheduledTaskAction -Execute $exe -Argument '"--heartbeat-only"' -WorkingDirectory $root
$bootTrigger = New-ScheduledTaskTrigger -AtStartup
$system = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
Register-ScheduledTask -TaskName "EmployeeMonitor-BootHeartbeat" -Action $bootAction -Trigger $bootTrigger -Principal $system -Settings $settings -Description "Employee Monitor device heartbeat only." -Force | Out-Null

$userAction = New-ScheduledTaskAction -Execute $exe -WorkingDirectory $root
$userTrigger = New-ScheduledTaskTrigger -AtLogOn -User $currentUser
$userPrincipal = New-ScheduledTaskPrincipal -UserId $currentUser -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName "EmployeeMonitor-UserSession" -Action $userAction -Trigger $userTrigger -Principal $userPrincipal -Settings $settings -Description "Visible Employee Monitor foreground application and approved work-folder metadata monitor." -Force | Out-Null

Start-ScheduledTask -TaskName "EmployeeMonitor-BootHeartbeat"
Start-Sleep -Seconds 3
Start-ScheduledTask -TaskName "EmployeeMonitor-UserSession"
'''
    def psquote(s):
        return str(s).replace("'", "''")
    ps = ps.replace("__EXE__", psquote(exe)).replace("__ROOT__", psquote(INSTALL))
    with tempfile.NamedTemporaryFile("w", suffix=".ps1", delete=False, encoding="utf-8") as f:
        f.write(ps)
        script = f.name
    try:
        result = subprocess.run(
            ["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script],
            capture_output=True, text=True, timeout=90
        )
    finally:
        try:
            os.unlink(script)
        except OSError:
            pass

    if result.returncode != 0:
        detail = (result.stderr or result.stdout or "Unknown Task Scheduler error")[-2500:]
        messagebox.showerror("Employee Monitor setup failed", detail)
        return

    messagebox.showinfo(
        "Employee Monitor installed",
        "Installation completed.\n\n"
        "• Device heartbeat starts with Windows.\n"
        "• Visible application monitoring starts when this employee signs in.\n"
        "• Application names are sampled approximately every 5 seconds.\n"
        "• Active time uses the configured 10-minute idle threshold.\n\n"
        "The agent collects process names and approved-folder file metadata only. "
        "It does not collect screenshots, keystrokes, window titles, passwords, "
        "browser page contents, or document contents.\n\n"
        "If this device is already approved, its existing device token is preserved."
    )

if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except Exception as exc:
        try:
            messagebox.showerror("Employee Monitor setup error", str(exc))
        except Exception:
            pass
