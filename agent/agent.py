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
from pathlib import Path
from datetime import datetime, timezone

import psutil
import requests
from watchdog.observers import Observer
from watchdog.events import FileSystemEventHandler

try:
    import win32gui
    import win32process
except ImportError:
    win32gui = win32process = None

HERE = Path(__file__).resolve().parent
CONFIG_PATH = HERE / "config.json"
TOKEN_PATH = HERE / "device_token.json"
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

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
        self.base = self.cfg["api_base_url"].rstrip("/")
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

    def enroll(self):
        payload = {
            "enrollment_code": self.cfg["enrollment_code"],
            "device_name": self.cfg.get("device_name") or socket.gethostname(),
            "employee_name": self.cfg["employee_name"]
        }
        response = self.session.post(self.base + "/api/enroll", json=payload, timeout=20)
        response.raise_for_status()
        self.token = response.json()["device_token"]
        TOKEN_PATH.write_text(json.dumps({"device_token": self.token}), encoding="utf-8")
        logging.info("Device enrolled successfully. Keep device_token.json private.")

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

    def foreground_app(self):
        if not win32gui:
            return None
        try:
            hwnd = win32gui.GetForegroundWindow()
            _, pid = win32process.GetWindowThreadProcessId(hwnd)
            return psutil.Process(pid).name()
        except Exception:
            return None

    def sample_app(self):
        now = time.time()
        interval = int(self.cfg.get("app_sample_seconds", 60))
        if now - self.last_app_time < interval:
            return
        self.last_app_time = now
        app = self.foreground_app()
        if app and app != self.last_app:
            self.last_app = app
            self.send_events([{
                "event_type": "application_foreground",
                "app_name": app,
                "details": "Foreground application process name",
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
    heartbeat_interval = int(agent.cfg.get("heartbeat_seconds", 60))
    last_heartbeat = 0
    try:
        while True:
            agent.sample_app()
            if time.time() - last_heartbeat >= heartbeat_interval:
                agent.heartbeat()
                last_heartbeat = time.time()
            time.sleep(5)
    except KeyboardInterrupt:
        logging.info("Stopping agent.")
    finally:
        observer.stop()
        observer.join()

if __name__ == "__main__":
    main()
