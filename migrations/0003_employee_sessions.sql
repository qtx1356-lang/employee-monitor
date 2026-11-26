-- Employee Monitor v2: daily, multi-session time accounting.
-- Session time is measured from Windows user logon to logoff/shutdown.
-- Active time is accumulated separately by the user-session agent.
CREATE TABLE IF NOT EXISTS employee_sessions (
  id TEXT PRIMARY KEY,
  device_id INTEGER NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  last_activity_at TEXT,
  active_seconds INTEGER NOT NULL DEFAULT 0,
  idle_seconds INTEGER NOT NULL DEFAULT 0,
  end_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(device_id) REFERENCES devices(id)
);

CREATE INDEX IF NOT EXISTS idx_sessions_device_started
  ON employee_sessions(device_id, started_at);
CREATE INDEX IF NOT EXISTS idx_sessions_open
  ON employee_sessions(device_id, ended_at);
CREATE INDEX IF NOT EXISTS idx_sessions_started
  ON employee_sessions(started_at);
