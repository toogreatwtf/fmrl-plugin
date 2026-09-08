export interface Config {
  baseUrl: string;
  apiKey?: string;
}

export const DEFAULT_BASE_URL = "https://fmrl.site";

/** loadConfig reads FMRL_API_URL and FMRL_API_KEY; the client appends /api/v1 to baseUrl. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const rawUrl = (env.FMRL_API_URL ?? "").trim();
  const baseUrl = (rawUrl === "" ? DEFAULT_BASE_URL : rawUrl).replace(/\/+$/, "");
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new Error(`FMRL_API_URL must be an http(s) URL, got ${JSON.stringify(rawUrl)}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`FMRL_API_URL must be an http(s) URL, got ${JSON.stringify(rawUrl)}`);
  }
  const rawKey = (env.FMRL_API_KEY ?? "").trim();
  return { baseUrl, apiKey: rawKey === "" ? undefined : rawKey };
}
