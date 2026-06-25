import { Env } from "../../env";

const MODELS = [
  "gemini-2.5-flash",
  "gemini-flash-latest",
];

const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/models";
const TIMEOUT_MS = 30000;
const MAX_ATTEMPTS = 3;

function isRetryable(status: number): boolean {
  return status === 503 || status === 429;
}

export async function geminiTranslate(
  env: Env,
  systemPrompt: string,
  userPrompt: string,
): Promise<string | null> {
  if (!env.GEMINI_API_KEY) {
    console.warn("geminiTranslate: GEMINI_API_KEY not configured");
    return null;
  }

  for (const model of MODELS) {
    const url = `${GEMINI_BASE_URL}/${model}:generateContent`;

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const startTime = Date.now();
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

      try {
        console.log("geminiTranslate:start", {
          model,
          attempt: attempt + 1,
          inputLength: userPrompt?.length,
        });

        const response = await fetch(`${url}?key=${env.GEMINI_API_KEY}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: systemPrompt }] },
            contents: [{ parts: [{ text: userPrompt }] }],
          }),
          signal: controller.signal,
        });

        console.log("geminiTranslate:fetch_done", {
          model,
          attempt: attempt + 1,
          durationMs: Date.now() - startTime,
          status: response.status,
          ok: response.ok,
        });

        if (!response.ok) {
          const errorText = await response.text();
          console.warn("geminiTranslate:http_error", {
            model,
            attempt: attempt + 1,
            status: response.status,
            statusText: response.statusText,
            body: errorText?.slice(0, 1000),
            durationMs: Date.now() - startTime,
          });

          if (isRetryable(response.status) && attempt < MAX_ATTEMPTS - 1) {
            const delay = Math.pow(2, attempt) * 500 + Math.random() * 300;
            console.log("geminiTranslate:retrying", {
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

        console.log("geminiTranslate:raw_response", {
          model,
          attempt: attempt + 1,
          durationMs: Date.now() - startTime,
          keys: Object.keys(data || {}),
          full: JSON.stringify(data)?.slice(0, 2000),
        });

        const candidate = data?.candidates?.[0];

        console.log("geminiTranslate:candidate_debug", {
          model,
          attempt: attempt + 1,
          hasCandidates: !!data?.candidates,
          candidatesLength: data?.candidates?.length,
          finishReason: candidate?.finishReason,
          safetyRatings: candidate?.safetyRatings,
          contentKeys: candidate?.content ? Object.keys(candidate.content) : null,
        });

        if (!data?.candidates) {
          console.warn("geminiTranslate:NO_CANDIDATES", {
            model,
            attempt: attempt + 1,
            durationMs: Date.now() - startTime,
            raw: JSON.stringify(data)?.slice(0, 1000),
          });
          break;
        }

        const text = candidate?.content?.parts?.[0]?.text;

        if (!text) {
          console.warn("geminiTranslate:EMPTY_TEXT", {
            model,
            attempt: attempt + 1,
            durationMs: Date.now() - startTime,
            candidate,
          });
          break;
        }

        console.log("geminiTranslate:success", {
          model,
          attempt: attempt + 1,
          durationMs: Date.now() - startTime,
          textLength: text.length,
        });
        return text;
      } catch (error: any) {
        console.warn("geminiTranslate:catch", {
          model,
          attempt: attempt + 1,
          error: error?.name ?? String(error),
          durationMs: Date.now() - startTime,
        });

        if (error?.name === "AbortError" && attempt < MAX_ATTEMPTS - 1) {
          const delay = Math.pow(2, attempt) * 500 + Math.random() * 300;
          console.log("geminiTranslate:retrying", {
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

  console.warn("geminiTranslate:all_models_exhausted");
  return null;
}
