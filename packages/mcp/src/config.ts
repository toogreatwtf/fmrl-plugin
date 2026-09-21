import { isRing } from "./crypto.js";

export interface Config {
  baseUrl: string;
  apiKey?: string;
  /** ring is FMRL_RING: the key ring to seal under instead of the stored one. */
  ring?: string;
}

export const DEFAULT_BASE_URL = "https://fmrl.site";

/** loadConfig reads FMRL_API_URL, FMRL_API_KEY and FMRL_RING; the client appends /api/v1 to baseUrl. */
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
  const rawRing = (env.FMRL_RING ?? "").trim();
  const ringLength = rawRing.length;
  // A ring is a secret: the message names its length, never its value.
  if (rawRing !== "" && !isRing(rawRing)) {
    throw new Error(`FMRL_RING must be a key ring, 43 base64url characters; got ${ringLength} characters.`);
  }
  return { baseUrl, apiKey: rawKey === "" ? undefined : rawKey, ring: rawRing === "" ? undefined : rawRing };
}
