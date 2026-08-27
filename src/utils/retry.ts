import { warn } from "./logger";

// Test hook: multiplies every retry wait. Keep at 1 in production; tests set
// it to 0 so backoff *sequences* are exercised without real waiting.
export const retryOptions = { delayScale: 1 };

export async function retryAsync<T>(fn: () => Promise<T>, retries = 2, delay = 2.0): Promise<T | null> {
  let attempt = 0;
  while (attempt <= retries) {
    try {
      return await fn();
    } catch (error) {
      attempt += 1;
      if (attempt > retries) {
        warn(`retryAsync failed after ${retries + 1} attempts`, error);
        return null;
      }
      const waitMs = Math.round((delay * 2 ** attempt + Math.random()) * 1000 * retryOptions.delayScale);
      warn(`retryAsync attempt ${attempt}/${retries} failed, retrying in ${waitMs}ms`, error);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }
  return null;
}
