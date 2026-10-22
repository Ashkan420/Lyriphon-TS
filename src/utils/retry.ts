import { warn } from "./logger";

// Test hook: multiplies every retry wait. Keep at 1 in production; tests set
// it to 0 so backoff *sequences* are exercised without real waiting.
export const retryOptions = { delayScale: 1 };

// An error that carries its own attempt cap. Services throw it for failures
// that waiting does not fix (e.g. an edge/IP block): retryAsync stops once
// `maxAttempts` attempts have been made instead of exhausting the caller's
// full budget. Unbounded failures keep the caller's default behavior.
export class BoundedRetryError extends Error {
  constructor(message: string, readonly maxAttempts: number) {
    super(message);
    this.name = "BoundedRetryError";
  }
}

export async function retryAsync<T>(fn: () => Promise<T>, retries = 2, delay = 2.0): Promise<T | null> {
  let attempt = 0;
  while (attempt <= retries) {
    try {
      return await fn();
    } catch (error) {
      attempt += 1;
      const cap = error instanceof BoundedRetryError ? error.maxAttempts : Infinity;
      if (attempt > retries || attempt >= cap) {
        warn(
          attempt >= cap && cap < Infinity
            ? `retryAsync gave up after ${attempt} attempts (capped) — ${error}`
            : `retryAsync failed after ${attempt} attempts`,
          error,
        );
        return null;
      }
      const waitMs = Math.round((delay * 2 ** attempt + Math.random()) * 1000 * retryOptions.delayScale);
      warn(`retryAsync attempt ${attempt}/${retries} failed, retrying in ${waitMs}ms`, error);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }
  return null;
}
