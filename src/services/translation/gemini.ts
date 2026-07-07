import { Env } from "../../env";
import { debug, warn } from "../../utils/logger";

const MODELS = [
  "gemini-3.1-flash-lite",
  "gemini-2.5-flash",
  "gemini-flash-latest",
];

const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/models";
const TIMEOUT_MS = 30000;
const MAX_ATTEMPTS = 3;

export type GeminiResult =
  | { type: "success"; text: string }
  | { type: "rate_limited"; retryAfterSeconds: number }
  | { type: "error" };

// Permanent client errors (bad key / bad request / forbidden) fail identically
// on every model, so there's no point falling through — bail out of the whole
// loop. Retryable server / quota errors are retried within a model and, if a
// model is exhausted, fall through to the next one.
const PERMANENT_STATUS = new Set([400, 401, 403]);
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

function isRetryable(status: number): boolean {
  return RETRYABLE_STATUS.has(status);
}

function parseRetryAfter(body: string): number {
  const match = body.match(/Please retry in ([\d.]+)s/);
  if (match) return parseFloat(match[1]);
  return 60;
}

export async function geminiTranslate(
  env: Env,
  systemPrompt: string,
  userPrompt: string,
  modules?: { base: boolean; source: string; secondary: string[]; target: string },
): Promise<GeminiResult> {
  if (!env.GEMINI_API_KEY) {
    warn("geminiTranslate: GEMINI_API_KEY not configured");
    return { type: "error" };
  }

  for (const model of MODELS) {
    const url = `${GEMINI_BASE_URL}/${model}:generateContent`;

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const startTime = Date.now();
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

      try {
        debug("geminiTranslate:start", {
          model,
          attempt: attempt + 1,
          inputLength: userPrompt?.length,
        });

        debug("geminiTranslate:modules", modules);

        const response = await fetch(`${url}?key=${env.GEMINI_API_KEY}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: systemPrompt }] },
            contents: [{ parts: [{ text: userPrompt }] }],
            generationConfig: {
              temperature: 0.1,
              topP: 0.6,
              topK: 10,
            },
          }),
          signal: controller.signal,
        });

        debug("geminiTranslate:fetch_done", {
          model,
          attempt: attempt + 1,
          durationMs: Date.now() - startTime,
          status: response.status,
          ok: response.ok,
        });

        if (!response.ok) {
          const errorText = await response.text();
          warn("geminiTranslate:http_error", {
            model,
            attempt: attempt + 1,
            status: response.status,
            statusText: response.statusText,
            body: errorText?.slice(0, 1000),
            durationMs: Date.now() - startTime,
          });

          if (response.status === 429) {
            const retryAfterSeconds = parseRetryAfter(errorText);
            warn("geminiTranslate:rate_limited", { model, attempt: attempt + 1, retryAfterSeconds });
            // Retry the SAME model with backoff; only surface rate_limited once
            // we've exhausted attempts. Permanent client errors (400/401/403)
            // break out of the loop instead — retrying those is futile.
            if (attempt < MAX_ATTEMPTS - 1) {
              const delay = retryAfterSeconds * 1000 + Math.random() * 300;
              debug("geminiTranslate:retrying_429", {
                model,
                attempt: attempt + 1,
                delayMs: Math.round(delay),
              });
              await new Promise((r) => setTimeout(r, delay));
              continue;
            }
            return { type: "rate_limited", retryAfterSeconds };
          }

          if (isRetryable(response.status) && attempt < MAX_ATTEMPTS - 1) {
            const delay = Math.pow(2, attempt) * 500 + Math.random() * 300;
            debug("geminiTranslate:retrying", {
              model,
              attempt: attempt + 1,
              delayMs: Math.round(delay),
            });
            await new Promise((r) => setTimeout(r, delay));
            continue;
          }
          break;
        }

        const data = await response.json() as any;

        debug("geminiTranslate:raw_response", {
          model,
          attempt: attempt + 1,
          durationMs: Date.now() - startTime,
          keys: Object.keys(data || {}),
          full: JSON.stringify(data)?.slice(0, 2000),
        });

        const candidate = data?.candidates?.[0];

        debug("geminiTranslate:candidate_debug", {
          model,
          attempt: attempt + 1,
          hasCandidates: !!data?.candidates,
          candidatesLength: data?.candidates?.length,
          finishReason: candidate?.finishReason,
          safetyRatings: candidate?.safetyRatings,
          contentKeys: candidate?.content ? Object.keys(candidate.content) : null,
        });

        if (!data?.candidates) {
          warn("geminiTranslate:NO_CANDIDATES", {
            model,
            attempt: attempt + 1,
            durationMs: Date.now() - startTime,
            raw: JSON.stringify(data)?.slice(0, 1000),
          });
          break;
        }

        const text = candidate?.content?.parts?.[0]?.text;

        if (!text) {
          warn("geminiTranslate:EMPTY_TEXT", {
            model,
            attempt: attempt + 1,
            durationMs: Date.now() - startTime,
            candidate,
          });
          break;
        }

        debug("geminiTranslate:success", {
          model,
          attempt: attempt + 1,
          durationMs: Date.now() - startTime,
          textLength: text.length,
        });
        return { type: "success", text };
      } catch (error: any) {
        warn("geminiTranslate:catch", {
          model,
          attempt: attempt + 1,
          error: error?.name ?? String(error),
          durationMs: Date.now() - startTime,
        });

        if (error?.name === "AbortError" && attempt < MAX_ATTEMPTS - 1) {
          const delay = Math.pow(2, attempt) * 500 + Math.random() * 300;
          debug("geminiTranslate:retrying", {
            model,
            attempt: attempt + 1,
            delayMs: Math.round(delay),
          });
          await new Promise((r) => setTimeout(r, delay));
          continue;
        }
        break;
      } finally {
        clearTimeout(timeout);
      }
    }
  }

  warn("geminiTranslate:all_models_exhausted");
  return { type: "error" };
}
