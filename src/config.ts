export const CHANNEL_LINK = "https://t.me/bichniga";
export const DEEZLOAD_BOT = "https://t.me/deezload2bot?start=";
export const DEFAULT_WEBHOOK_PATH = "webhook";

// HTTP resilience
export const HTTP_TIMEOUT_MS = 8000;
export const DEEZER_MAX_RETRIES = 5;       // total attempts = retries + 1
export const LRCLIB_TIMEOUT_MS = 8000;
export const LRCLIB_MAX_RETRIES = 1;       // 2 attempts max when flaky, not endless

// Logger — room for a full search → lyrics → telegraph pipeline per interaction
export const LOG_BUFFER_SIZE = 120;

// Telegram effects
export const MESSAGE_EFFECT_CONFETTI = "5046509860389126442";

// Deezload auto-fetch bridge (teleproto userbot in a DO relays jobs through
// @deezload2bot).
export const AUTOFETCH_MAX_PENDING_PER_USER = 3;
export const AUTOFETCH_REQUEST_TTL_SECONDS = 7200;
// Hard cap for one bridge job (deezload wait + forward); the DO alarm
// watchdog fails jobs that exceed it.
export const AUTOFETCH_JOB_TIMEOUT_MS = 240000;
