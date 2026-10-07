import { semverParts } from "./plugin.js";

/** REGISTRY_URL is where npm says which fmrl-mcp is the latest: the version a fresh `npx -y fmrl-mcp` would run. */
export const REGISTRY_URL = "https://registry.npmjs.org/fmrl-mcp/latest";

/**
 * latestOnNpm asks the registry for fmrl-mcp's latest version, so a session
 * that has run for days can learn it is behind. It is bounded by timeoutMs
 * and throws one plain sentence on anything but a version.
 */
export async function latestOnNpm({ fetchImpl = fetch, timeoutMs = 3000 }: { fetchImpl?: typeof fetch; timeoutMs?: number } = {}): Promise<string> {
  let res: Response;
  try {
    res = await fetchImpl(REGISTRY_URL, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    if (e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError")) throw new Error(`No answer from the npm registry within ${timeoutMs / 1000} s.`);
    const cause = (e as { cause?: { message?: string } }).cause?.message ?? (e instanceof Error ? e.message : String(e));
    throw new Error(`Couldn't reach the npm registry: ${cause}`);
  }
  if (!res.ok) throw new Error(`The npm registry answered ${res.status}.`);
  let version: unknown;
  try {
    version = ((await res.json()) as { version?: unknown } | null)?.version;
  } catch {
    version = undefined;
  }
  if (typeof version !== "string" || !semverParts(version)) throw new Error("The npm registry answered without a version.");
  return version;
}
