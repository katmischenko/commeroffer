CREATE TABLE IF NOT EXISTS diagnostic_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  attempt_id TEXT NOT NULL UNIQUE,
  student_name TEXT NOT NULL,
  student_class TEXT NOT NULL,
  direction TEXT NOT NULL,
  experience TEXT NOT NULL DEFAULT '',
  score INTEGER NOT NULL CHECK (score >= 0),
  max_score INTEGER NOT NULL CHECK (max_score = 15),
  percentage INTEGER NOT NULL CHECK (percentage BETWEEN 0 AND 100),
  completed_at TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  telegram_status TEXT NOT NULL DEFAULT 'pending' CHECK (telegram_status IN ('pending','sending','sent')),
  telegram_claimed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_diagnostic_attempts_completed_at
  ON diagnostic_attempts (completed_at DESC);

CREATE INDEX IF NOT EXISTS idx_diagnostic_attempts_student
  ON diagnostic_attempts (student_name, student_class);

CREATE INDEX IF NOT EXISTS idx_diagnostic_attempts_direction
  ON diagnostic_attempts (direction, student_class);
