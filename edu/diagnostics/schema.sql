CREATE TABLE IF NOT EXISTS diagnostic_attempts (
  attempt_id TEXT PRIMARY KEY,
  student_name TEXT NOT NULL,
  student_class TEXT NOT NULL,
  direction TEXT NOT NULL,
  experience TEXT,
  score INTEGER NOT NULL CHECK (score >= 0 AND score <= 15),
  max_score INTEGER NOT NULL CHECK (max_score = 15),
  percentage INTEGER NOT NULL CHECK (percentage >= 0 AND percentage <= 100),
  completed_at TEXT NOT NULL,
  payload_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_diagnostic_student ON diagnostic_attempts(student_name, direction, student_class, completed_at);
CREATE INDEX IF NOT EXISTS idx_diagnostic_date ON diagnostic_attempts(completed_at);