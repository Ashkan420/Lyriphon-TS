export async function retryAsync<T>(fn: () => Promise<T>, retries = 2, delay = 2.0): Promise<T | null> {
  let attempt = 0;
  while (attempt <= retries) {
    try {
      return await fn();
    } catch (error) {
      attempt += 1;
      if (attempt > retries) {
        console.warn(`retryAsync failed after ${retries + 1} attempts`, error);
        return null;
      }
      const waitMs = Math.round((delay * 2 ** attempt + Math.random()) * 1000);
      console.warn(`retryAsync attempt ${attempt}/${retries} failed, retrying in ${waitMs}ms`, error);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }
  return null;
}
