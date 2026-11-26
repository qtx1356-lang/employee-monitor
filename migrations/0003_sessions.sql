CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id INTEGER NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  last_heartbeat TEXT NOT NULL,
  active_seconds INTEGER NOT NULL DEFAULT 0,
  end_reason TEXT,
  FOREIGN KEY(device_id) REFERENCES devices(id)
);

CREATE INDEX IF NOT EXISTS idx_sessions_device_started
ON sessions(device_id, started_at);

CREATE INDEX IF NOT EXISTS idx_sessions_open
ON sessions(device_id, ended_at);
