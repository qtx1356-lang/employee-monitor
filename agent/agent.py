"""
Visible Windows employee-monitoring prototype.
Collects foreground application process names and file-system change metadata
only in explicitly configured company work folders. It does not capture keystrokes,
screenshots, document contents, passwords, or browser page contents.
"""
import json
import os
import socket
import time
import logging
import sys
import ctypes
from ctypes import wintypes
from pathlib import Path
from datetime import datetime, timezone

import psutil
import requests
from watchdog.observers import Observer
from watchdog.events import FileSystemEventHandler

# Use the native Windows API directly. This avoids depending on pywin32
# being importable in the packaged executable.
def get_foreground_process_name():
    if os.name != "nt":
        return None
    try:
        user32 = ctypes.WinDLL("user32", use_last_error=True)
        get_foreground = user32.GetForegroundWindow
        get_foreground.restype = wintypes.HWND
        get_pid = user32.GetWindowThreadProcessId
        get_pid.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.DWORD)]
        get_pid.restype = wintypes.DWORD
        hwnd = get_foreground()
        if not hwnd:
            return None
        pid = wintypes.DWORD(0)
        if not get_pid(hwnd, ctypes.byref(pid)) or not pid.value:
            return None
        return psutil.Process(pid.value).name()
    except (OSError, psutil.Error, AttributeError, ValueError):
        return None

def get_idle_seconds():
    """Seconds since last keyboard/mouse input in the current interactive session."""
    if os.name != "nt":
        return 0
    class LASTINPUTINFO(ctypes.Structure):
        _fields_ = [("cbSize", wintypes.UINT), ("dwTime", wintypes.DWORD)]
    info = LASTINPUTINFO()
    info.cbSize = ctypes.sizeof(LASTINPUTINFO)
    try:
        user32 = ctypes.WinDLL("user32", use_last_error=True)
        if not user32.GetLastInputInfo(ctypes.byref(info)):
            return 0
        return max(0, (ctypes.windll.kernel32.GetTickCount() - info.dwTime) / 1000.0)
    except (OSError, AttributeError):
        return 0

HERE = Path(sys.executable).resolve().parent if getattr(sys, "frozen", False) else Path(__file__).resolve().parent
CONFIG_PATH = HERE / "config.json"
TOKEN_PATH = HERE / "device_token.json"
LOG_DIR = Path(os.environ.get("LOCALAPPDATA", os.environ.get("PROGRAMDATA", "."))) / "EmployeeMonitor" / "logs"
LOG_DIR.mkdir(parents=True, exist_ok=True)
LOG_NAME = "boot-heartbeat.log" if "--heartbeat-only" in sys.argv else "user-session.log"
_log_handlers = [logging.FileHandler(LOG_DIR / LOG_NAME, encoding="utf-8")]
if "--heartbeat-only" not in sys.argv:
    _log_handlers.append(logging.StreamHandler(sys.stdout))
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s", handlers=_log_handlers)

def utc_now():
    return datetime.now(timezone.utc).isoformat()

def load_json(path):
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)

class Agent:
    def __init__(self):
        if not CONFIG_PATH.exists():
            raise RuntimeError("Create agent/config.json from config.example.json first.")
        self.cfg = load_json(CONFIG_PATH)
        self.base = self.cfg.get("api_base_url", "https://employee-monitor.s16530460.workers.dev").rstrip("/")
        self.session = requests.Session()
        self.session.headers.update({"Content-Type": "application/json"})
        self.token = None
        if TOKEN_PATH.exists():
            self.token = load_json(TOKEN_PATH).get("device_token")
        if not self.token:
            self.enroll()
        self.session.headers.update({"X-Device-Token": self.token})
        self.last_app = None
        self.last_app_time = 0
        self.running_apps = set()

    def enroll(self):
        payload = {
            "device_name": self.cfg.get("device_name") or socket.gethostname(),
            "employee_name": self.cfg["employee_name"]
        }
        response = self.session.post(self.base + "/api/enroll", json=payload, timeout=20)
        response.raise_for_status()
        self.token = response.json()["device_token"]
        TOKEN_PATH.write_text(json.dumps({"device_token": self.token}), encoding="utf-8")
        logging.info("Registration request submitted. Device is pending administrator approval. Keep device_token.json private.")

    def send_events(self, events):
        if not events:
            return
        try:
            r = self.session.post(self.base + "/api/events", json={"events": events}, timeout=20)
            r.raise_for_status()
            logging.info("Sent %s event(s).", len(events))
        except requests.RequestException as exc:
            logging.warning("Could not send events: %s", exc)

    def heartbeat(self):
        try:
            r = self.session.post(self.base + "/api/heartbeat", timeout=15)
            r.raise_for_status()
        except requests.RequestException as exc:
            logging.warning("Heartbeat failed: %s", exc)

    def session_request(self, action, payload=None):
        try:
            response = self.session.post(self.base + "/api/session/" + action, json=payload or {}, timeout=15)
            response.raise_for_status()
            return response.json()
        except requests.RequestException as exc:
            logging.warning("Session %s failed: %s", action, exc)
            return None

    def foreground_app(self):
        return get_foreground_process_name()

    def sample_app(self):
        # Sample frequently so short application switches are not missed.
        now = time.time()
        interval = max(2, min(int(self.cfg.get("app_sample_seconds", 5)), 30))
        if now - self.last_app_time < interval:
            return
        self.last_app_time = now
        # Report application process start/exit transitions by process name only.
        # System and monitor processes are excluded; no window titles or content.
        ignored = {"system", "registry", "smss.exe", "csrss.exe", "wininit.exe",
                   "services.exe", "lsass.exe", "svchost.exe", "runtimebroker.exe",
                   "employeeMonitorAgent.exe".lower(), "cmd.exe", "powershell.exe",
                   "conhost.exe", "taskhostw.exe", "dwm.exe"}
        current = set()
        try:
            for proc in psutil.process_iter(["name"]):
                name = proc.info.get("name")
                if name and name.lower() not in ignored:
                    current.add(name)
        except (psutil.Error, OSError):
            pass
        for name in sorted(current - self.running_apps):
            self.send_events([{"event_type": "application_opened", "app_name": name,
                               "details": "Application process started; process name only",
                               "occurred_at": utc_now()}])
        for name in sorted(self.running_apps - current):
            self.send_events([{"event_type": "application_closed", "app_name": name,
                               "details": "Application process exited; process name only",
                               "occurred_at": utc_now()}])
        self.running_apps = current
        app = self.foreground_app()
        if not app:
            return
        # Do not report the monitor itself or its launcher shell as employee work.
        ignored = {"EmployeeMonitorAgent.exe", "cmd.exe", "powershell.exe", "conhost.exe"}
        if app.lower() in {name.lower() for name in ignored}:
            return
        if app != self.last_app:
            self.last_app = app
            self.send_events([{
                "event_type": "application_foreground",
                "app_name": app,
                "details": "Foreground application process name only; no window title or content collected",
                "occurred_at": utc_now()
            }])

class WorkFolderHandler(FileSystemEventHandler):
    def __init__(self, agent):
        self.agent = agent

    def on_any_event(self, event):
        if event.is_directory:
            return
        self.agent.send_events([{
            "event_type": "file_" + event.event_type,
            "file_name": os.path.basename(event.src_path),
            "details": "Change detected in an approved work folder",
            "occurred_at": utc_now()
        }])

def main():
    if os.name != "nt":
        raise RuntimeError("This monitoring agent prototype supports Windows 10/11 only.")
    agent = Agent()
    # The startup task runs this mode as SYSTEM before any employee signs in.
    # It sends heartbeats only; foreground-app detection runs in the interactive
    # user session after Windows logon.
    if "--heartbeat-only" in sys.argv:
        interval = max(30, min(int(agent.cfg.get("heartbeat_seconds", 60)), 300))
        logging.info("Boot heartbeat component running. Foreground application monitoring waits for user logon.")
        while True:
            agent.heartbeat()
            time.sleep(interval)

    observer = Observer()
    handler = WorkFolderHandler(agent)
    for folder in agent.cfg.get("approved_work_folders", []):
        p = Path(folder)
        if p.exists() and p.is_dir():
            observer.schedule(handler, str(p), recursive=True)
            logging.info("Watching approved work folder: %s", p)
        else:
            logging.warning("Configured work folder does not exist: %s", p)
    observer.start()
    logging.info("Agent running visibly. Press Ctrl+C to stop.")
    heartbeat_interval = max(30, min(int(agent.cfg.get("heartbeat_seconds", 60)), 120))
    idle_threshold = max(1, int(agent.cfg.get("idle_threshold_minutes", 10))) * 60
    last_heartbeat = 0
    agent.session_request("start")
    try:
        while True:
            try:
                agent.sample_app()
            except Exception:
                logging.exception("Application sampling failed; heartbeat loop will continue.")
            if time.time() - last_heartbeat >= heartbeat_interval:
                idle = get_idle_seconds() >= idle_threshold
                agent.session_request("heartbeat", {"idle": idle})
                agent.heartbeat()
                last_heartbeat = time.time()
            time.sleep(5)
    except KeyboardInterrupt:
        logging.info("Stopping agent.")
        agent.session_request("end", {"idle": get_idle_seconds() >= idle_threshold})
    finally:
        observer.stop()
        observer.join()

if __name__ == "__main__":
    main()
