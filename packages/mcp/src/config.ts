import { isRing } from "./crypto.js";

export interface Config {
  baseUrl: string;
  apiKey?: string;
  /** ring is FMRL_RING: the key ring to seal under instead of the stored one. */
  ring?: string;
  /** agentName is FMRL_AGENT_NAME: the name revisions made with this key carry. */
  agentName?: string;
}

/** MAX_NAME is the server's limit on a key's label, in code points. */
const MAX_NAME = 64;

/** agentNameFrom trims FMRL_AGENT_NAME and keeps it when it is a name the server takes; anything else is ignored with one warning that never echoes it. */
function agentNameFrom(raw: string | undefined, warn: (line: string) => void): string | undefined {
  const name = (raw ?? "").trim();
  if (name === "") return undefined;
  if ([...name].length > MAX_NAME || /\p{Cc}/u.test(name)) {
    warn(`fmrl-mcp: FMRL_AGENT_NAME is ignored: a name is at most ${MAX_NAME} characters, with no control characters.`);
    return undefined;
  }
  return name;
}

export const DEFAULT_BASE_URL = "https://fmrl.site";

/** loadConfig reads FMRL_API_URL, FMRL_API_KEY, FMRL_RING and FMRL_AGENT_NAME; the client appends /api/v1 to baseUrl. warn takes the one line a bad FMRL_AGENT_NAME costs. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env, warn: (line: string) => void = (line) => process.stderr.write(line + "\n")): Config {
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
  const agentName = agentNameFrom(env.FMRL_AGENT_NAME, warn);
  return { baseUrl, apiKey: rawKey === "" ? undefined : rawKey, ring: rawRing === "" ? undefined : rawRing, ...(agentName ? { agentName } : {}) };
}
