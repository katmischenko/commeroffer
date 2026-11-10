-- Apply once to an existing diagnostic_attempts table before deploying worker.js.
ALTER TABLE diagnostic_attempts
  ADD COLUMN telegram_status TEXT NOT NULL DEFAULT 'pending'
  CHECK (telegram_status IN ('pending','sending','sent'));

ALTER TABLE diagnostic_attempts
  ADD COLUMN telegram_claimed_at TEXT;
