export type ApiTarget = "deezer" | "lrclib";

type ApiHeaders = Record<string, string>;

interface ApiRequest {
  url: string;
  headers: ApiHeaders;
}

const UPSTREAM_ORIGINS: Record<ApiTarget, string> = {
  deezer: "https://api.deezer.com",
  lrclib: "https://lrclib.net",
};

/**
 * Route through Vercel only when BOTH relay settings are configured.
 * Otherwise, preserve the original URL and headers for direct requests.
 */
export function prepareApiRequest(
  target: ApiTarget,
  upstreamUrl: string,
  headers: ApiHeaders,
): ApiRequest {
  const relayBase = (process.env.API_RELAY_URL ?? "")
    .trim()
    .replace(/\/+$/, "");

  const relaySecret = (process.env.API_RELAY_SECRET ?? "").trim();

  // Relay is optional. Normal Lyriphon installations need no configuration.
  if (!relayBase || !relaySecret) {
    return {
      url: upstreamUrl,
      headers,
    };
  }

  const upstream = new URL(upstreamUrl);

  // Never forward an arbitrary URL through the relay.
  if (upstream.origin !== UPSTREAM_ORIGINS[target]) {
    throw new Error(`Unexpected ${target} upstream URL`);
  }

  // Matches your existing Vercel api/proxy.js handler.
  const relayUrl = new URL(`${relayBase}/api/proxy`);

  relayUrl.searchParams.set("target", target);
  relayUrl.searchParams.set(
    "path",
    upstream.pathname.replace(/^\/+/, ""),
  );

  upstream.searchParams.forEach((value, key) => {
    relayUrl.searchParams.append(key, value);
  });

  return {
    url: relayUrl.toString(),
    headers: {
      ...headers,
      "X-Relay-Key": relaySecret,
    },
  };
}