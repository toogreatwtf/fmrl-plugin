import type { CredentialsFile } from "./credentials.js";
import { isRing } from "./crypto.js";
import { prefixOf } from "./keys.js";

export interface LocalVaultRing { prefix: string; ring: string }

function isPrefix(value: unknown): value is string {
  return typeof value === "string" && value.length === 9 && /^fmrl_[A-Za-z0-9]{4}$/.test(value);
}

function isCanonicalRing(value: unknown): value is string {
  return isRing(value) && Buffer.from(value, "base64url").toString("base64url") === value;
}

/** Every credential-file ring, with numeric history first and the configured key last. */
export function collectVaultRings(file: CredentialsFile, baseUrl: string): LocalVaultRing[] {
  const rows: LocalVaultRing[] = [];
  const history = Object.entries(file.rings ?? {}).map(([name, ring]) => {
    const suffix = name.match(/\.([2-9][0-9]*|1[0-9]+)$/);
    return { prefix: suffix ? name.slice(0, -suffix[0].length) : name,
      variant: suffix ? BigInt(suffix[1]) : 1n, ring };
  });
  history.sort((a, b) => a.prefix < b.prefix ? -1 : a.prefix > b.prefix ? 1 :
    a.variant < b.variant ? -1 : a.variant > b.variant ? 1 : 0);
  for (const { prefix, ring } of history) {
    if (isPrefix(prefix) && isCanonicalRing(ring)) rows.push({ prefix, ring });
  }
  const addKey = (entry: unknown): void => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return;
    const { key, prefix: storedPrefix, ring } = entry as { key?: unknown; prefix?: unknown; ring?: unknown };
    const prefix = storedPrefix === undefined || storedPrefix === "" ?
      typeof key === "string" ? prefixOf(key) : undefined : storedPrefix;
    if (isPrefix(prefix) && isCanonicalRing(ring)) rows.push({ prefix, ring });
  };
  for (const url of Object.keys(file.keys).sort()) {
    if (url !== baseUrl) addKey(file.keys[url]);
  }
  addKey(file.keys[baseUrl]);
  // Keep the last exact pair, preserving the active ring's final position.
  const seen = new Set<string>();
  return rows.reverse().filter(({ prefix, ring }) => {
    const pair = `${prefix}|${ring}`;
    if (seen.has(pair)) return false;
    seen.add(pair);
    return true;
  }).reverse();
}

/** Preserve upload order with no repeated prefix and at most 50 rows per request. */
export function batchVaultRings(rings: LocalVaultRing[]): LocalVaultRing[][] {
  const batches: LocalVaultRing[][] = [];
  let batch: LocalVaultRing[] = [];
  let seen = new Set<string>();
  for (const row of rings) {
    if (batch.length === 50 || seen.has(row.prefix)) {
      batches.push(batch); batch = []; seen = new Set();
    }
    batch.push(row); seen.add(row.prefix);
  }
  if (batch.length || batches.length === 0) batches.push(batch);
  return batches;
}
