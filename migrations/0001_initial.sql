CREATE TABLE IF NOT EXISTS devices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  device_name TEXT NOT NULL UNIQUE,
  employee_name TEXT NOT NULL,
  device_token TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  last_seen TEXT,
  is_active INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_devices_employee_name ON devices(employee_name);
CREATE INDEX IF NOT EXISTS idx_devices_device_token ON devices(device_token);

CREATE TABLE IF NOT EXISTS activities (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  app_name TEXT,
  file_name TEXT,
  details TEXT,
  idle INTEGER,
  occurred_at TEXT NOT NULL,
  FOREIGN KEY(device_id) REFERENCES devices(id)
);

CREATE INDEX IF NOT EXISTS idx_activities_device_id ON activities(device_id);
CREATE INDEX IF NOT EXISTS idx_activities_event_type ON activities(event_type);
CREATE INDEX IF NOT EXISTS idx_activities_occurred_at ON activities(occurred_at);
