-- Existing rows created before explicit Telegram opt-in have no recorded consent.
-- Mark them as not opted in and prevent any pending notification from being retried.
UPDATE diagnostic_attempts
SET telegram_consent = 0,
    telegram_status = 'sent',
    telegram_claimed_at = NULL
WHERE consent_version = 'legacy';
