ALTER TABLE devices ADD COLUMN approval_status TEXT NOT NULL DEFAULT 'approved';
CREATE INDEX IF NOT EXISTS idx_devices_approval_status ON devices(approval_status);
