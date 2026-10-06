import type { CredentialsFile } from "./credentials.js";
import { isRing } from "./crypto.js";
import { type KeyStore, prefixOf } from "./keys.js";
import { ApiError, type FmrlApi, type MeResponse } from "./api.js";
import { sealVaultRing, vaultFingerprint } from "./vault-crypto.js";

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

export type VaultSyncResult =
  | { state: "none"; fingerprint?: string; firstPin?: boolean }
  | { state: "changed"; previous: string; fingerprint: string }
  | { state: "synced"; fingerprint: string; firstPin: boolean }
  | { state: "unknown"; fingerprint?: string; firstPin: boolean };

export interface VaultSyncOptions { api: FmrlApi; keys: KeyStore; log?: (line: string) => void }

/** Seals a credential snapshot for the pinned account vault, with no retries or caching. */
export class VaultSync {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly o: VaultSyncOptions) {}

  /** Each pass finishes before the next begins; credential-file operations use KeyStore's queue. */
  sync(key: string, options: { me?: MeResponse; trust?: string } = {}): Promise<VaultSyncResult> {
    const result = this.queue.then(() => this.run(key, options), () => this.run(key, options));
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }

  private async run(key: string, options: { me?: MeResponse; trust?: string }): Promise<VaultSyncResult> {
    let firstPin = false;
    let fingerprint: string | undefined;
    let completedBatch = false;
    try {
      const me = options.me ?? await this.o.api.me(key);
      if (me.account_vault === undefined) return { state: "none" };
      const vault = me.account_vault;
      if (!vault || typeof vault !== "object" || Array.isArray(vault) ||
          typeof vault.pub !== "string" || typeof vault.fingerprint !== "string") {
        throw new Error("invalid account vault");
      }
      fingerprint = vaultFingerprint(vault.pub);
      if (fingerprint !== vault.fingerprint) throw new Error("invalid vault fingerprint");
      const pin = await this.o.keys.pinVault(new URL(this.o.api.viewerBase).origin, fingerprint, options.trust);
      if (pin.kind === "changed") return { state: "changed", previous: pin.previous, fingerprint };
      if (pin.kind === "invalid-trust") throw new Error("invalid vault trust");
      firstPin = pin.first;
      const rows = collectVaultRings(await this.o.keys.vaultSnapshot(), this.o.api.viewerBase);
      for (const batch of batchVaultRings(rows)) {
        const boxes = batch.map(({ prefix, ring }) => ({ prefix, box: sealVaultRing(vault.pub, prefix, ring) }));
        const response = await this.o.api.putRings(key, boxes);
        if (response.stored !== boxes.length) throw new Error("incomplete vault sync");
        completedBatch = true;
      }
      return { state: "synced", fingerprint, firstPin };
    } catch (e) {
      if (e instanceof ApiError && (e.status === 403 || e.status === 409)) {
        return { state: completedBatch ? "unknown" : "none", fingerprint, firstPin };
      }
      // Diagnostics are best effort too: a logger failure must not reject the primary tool call.
      try { this.o.log?.("fmrl-mcp: vault sync failed"); } catch {}
      return { state: "unknown", fingerprint, firstPin };
    }
  }
}
