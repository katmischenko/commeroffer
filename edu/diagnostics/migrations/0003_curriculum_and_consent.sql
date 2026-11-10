-- Per-student curriculum metadata and separate Telegram opt-in.
ALTER TABLE diagnostic_attempts ADD COLUMN curriculum_id TEXT NOT NULL DEFAULT 'unspecified';
ALTER TABLE diagnostic_attempts ADD COLUMN curriculum_name TEXT NOT NULL DEFAULT '';
ALTER TABLE diagnostic_attempts ADD COLUMN curriculum_detail TEXT NOT NULL DEFAULT '';
ALTER TABLE diagnostic_attempts ADD COLUMN consent_version TEXT NOT NULL DEFAULT 'legacy';
ALTER TABLE diagnostic_attempts ADD COLUMN telegram_consent INTEGER NOT NULL DEFAULT 1 CHECK (telegram_consent IN (0,1));

CREATE INDEX IF NOT EXISTS idx_diagnostic_attempts_curriculum
  ON diagnostic_attempts (curriculum_id, direction, student_class);
