import { credentialOrigin, type CredentialsFile } from "./credentials.js";
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

/** Locally proven same-origin rings; numeric history first and configured key last. */
export function collectVaultRings(file: CredentialsFile, baseUrl: string): LocalVaultRing[] {
  const origin = credentialOrigin(baseUrl);
  if (!origin) return [];
  const rows: LocalVaultRing[] = [];
  const localKeys: LocalVaultRing[] = [];
  const addKey = (entry: unknown): void => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return;
    const { key, prefix: storedPrefix, ring } = entry as { key?: unknown; prefix?: unknown; ring?: unknown };
    const prefix = storedPrefix === undefined || storedPrefix === "" ?
      typeof key === "string" ? prefixOf(key) : undefined : storedPrefix;
    if (isPrefix(prefix) && isCanonicalRing(ring)) localKeys.push({ prefix, ring });
  };
  for (const url of Object.keys(file.keys).sort()) {
    if (url !== baseUrl && credentialOrigin(url) === origin) addKey(file.keys[url]);
  }
  addKey(file.keys[baseUrl]);
  const history = Object.entries(file.rings ?? {}).map(([name, ring]) => {
    const suffix = name.match(/\.([2-9][0-9]*|1[0-9]+)$/);
    return { name, prefix: suffix ? name.slice(0, -suffix[0].length) : name,
      variant: suffix ? BigInt(suffix[1]) : 1n, ring };
  });
  history.sort((a, b) => a.prefix < b.prefix ? -1 : a.prefix > b.prefix ? 1 :
    a.variant < b.variant ? -1 : a.variant > b.variant ? 1 : 0);
  for (const { name, prefix, ring } of history) {
    const recorded = file.ring_origins?.[name];
    const proven = recorded === origin || (recorded === undefined &&
      localKeys.some(row => row.prefix === prefix && row.ring === ring));
    if (proven && isPrefix(prefix) && isCanonicalRing(ring)) rows.push({ prefix, ring });
  }
  rows.push(...localKeys);
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

/** Seals an origin-scoped snapshot; bounded 400 isolation, no operational retries or caching. */
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
    let refused = false;
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
      const snapshot = await this.o.keys.vaultSnapshot();
      const rows = collectVaultRings(snapshot, this.o.api.viewerBase);
      const active = this.o.keys.vaultActiveRing(snapshot, key);
      const activeRow = rows.find(row => row.prefix === active.prefix && row.ring === active.ring);
      // Only the actual active variant can survive under this prefix. Sending
      // superseded variants first risks budget starvation; sending them later
      // would overwrite the useful box. Keep those variants on disk instead.
      const rest = rows.filter(row => row.prefix !== active.prefix);
      const batches = activeRow ? [[activeRow], ...(rest.length ? batchVaultRings(rest) : [])] : batchVaultRings(rest);
      let attempts = 0;
      let activeUploaded = false;
      const upload = async (batch: LocalVaultRing[]): Promise<void> => {
        if (attempts >= 10) throw new Error("vault sync attempt limit");
        attempts++;
        const boxes = batch.map(({ prefix, ring }) => ({ prefix, box: sealVaultRing(vault.pub, prefix, ring) }));
        try {
          const response = await this.o.api.putRings(key, boxes);
          if (response.stored !== boxes.length) throw new Error("incomplete vault sync");
          completedBatch = true;
          if (activeRow && batch.includes(activeRow)) activeUploaded = true;
        } catch (e) {
          if (!(e instanceof ApiError) || e.status !== 400) throw e;
          refused = true;
          // PR1 rejects atomically. Isolate each member once, never repeat a
          // refused singleton or retry an operational/network failure.
          if (batch.length > 1) for (const row of batch) await upload([row]);
        }
      };
      for (const batch of batches) await upload(batch);
      if (refused) throw new Error("vault sync refused rows");
      return { state: activeUploaded ? "synced" : "unknown", fingerprint, firstPin };
    } catch (e) {
      if (e instanceof ApiError && (e.status === 403 || e.status === 409)) {
        return { state: e.status === 409 || completedBatch || refused ? "unknown" : "none", fingerprint, firstPin };
      }
      // Diagnostics are best effort too: a logger failure must not reject the primary tool call.
      try { this.o.log?.("fmrl-mcp: vault sync failed"); } catch {}
      return { state: "unknown", fingerprint, firstPin };
    }
  }
}
