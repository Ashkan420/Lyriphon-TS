-- Inline-mode auto-fetch: the sent inline message a job should edit itself
-- into (audio + Lyrics button) on delivery. Nullable — DM requests stay NULL
-- and inline rows use chat_id 0.
ALTER TABLE audio_requests ADD COLUMN inline_message_id TEXT;
