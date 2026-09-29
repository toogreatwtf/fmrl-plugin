import { ApiError, type FmrlApi } from "./api.js";
import { readCredentials, writeCredentials, type CredentialsFile } from "./credentials.js";
import { isRing, newRing } from "./crypto.js";

export interface KeyStoreOptions {
  api: FmrlApi;
  baseUrl: string;
  file: string;
  apiKeyFromEnv?: string;
  /** ringFromEnv is FMRL_RING: every private page's record is sealed under it, and it is never written to the file. */
  ringFromEnv?: string;
  log?: (line: string) => void;
}

/** MINT_LABEL is the name every key this plugin mints starts with; the MCP client's name replaces it as it fills an empty one. */
export const MINT_LABEL = "fmrl-mcp";

/** PREFIX_LENGTH is the server's apikey.PrefixLength. A key's prefix is what the link page names, and what a #r= pair pairs a ring with. */
export const PREFIX_LENGTH = 9;

/** prefixOf is a key's display prefix: fmrl_ and four characters. */
export function prefixOf(key: string): string {
  return key.slice(0, PREFIX_LENGTH);
}

/**
 * normalizeKeyCode is keylife's normalization of a key code: dashes and
 * whitespace stripped, uppercased, and then exactly 26 characters of the
 * RFC 4648 base32 alphabet. Anything else is undefined, so a mistyped code
 * never spends one of the network's hourly redemptions.
 */
export function normalizeKeyCode(code: string): string | undefined {
  const norm = code.replace(/[-\s]/g, "").toUpperCase();
  return /^[A-Z2-7]{26}$/.test(norm) ? norm : undefined;
}

/** storedRing is the ring the file keeps for key: its base URL's entry when that entry is key, else rings[prefix]. */
function storedRing(file: CredentialsFile, baseUrl: string, key: string): string | undefined {
  const entry = file.keys[baseUrl];
  if (entry?.key === key && isRing(entry.ring)) return entry.ring;
  const ring = file.rings?.[prefixOf(key)];
  return isRing(ring) ? ring : undefined;
}

/**
 * KeyStore resolves the key every call uses: FMRL_API_KEY when set, else the
 * credentials file's entry for this base URL, else a freshly minted key that
 * is saved for next time. A stored key that answers 401 (revoked, or a
 * preview whose memory store restarted) is replaced once and the call
 * retried; a key from the environment is never replaced. Each key also has a
 * ring, the secret its private pages' keys are sealed under (ringFor).
 */
export class KeyStore {
  private cached?: string;
  private pending?: Promise<string>;
  private readonly ringPending = new Map<string, Promise<string>>();
  /** fileQueue orders this store's own read-modify-write cycles on the credentials file; see serialize. */
  private fileQueue: Promise<unknown> = Promise.resolve();
  constructor(private readonly o: KeyStoreOptions) {}

  /**
   * serialize runs fn only after every earlier serialize call on this store
   * has settled, so two read-modify-write cycles on the credentials file
   * (a ring mint for one key, a key mint for another) never interleave and
   * clobber each other's write. It only orders writes within this process:
   * two processes sharing the file (two agent sessions) still race — the
   * last writer wins, and a ring the losing process minted, which may
   * already have sealed a record or gone out in a link, is lost from the
   * file. The window is one read-modify-write, once per key. Accepted.
   */
  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.fileQueue.then(fn, fn);
    this.fileQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /** file is where the key and its ring live. */
  get file(): string {
    return this.o.file;
  }

  /** keyFromEnv reports whether FMRL_API_KEY supplies the key: then nothing here replaces it. */
  get keyFromEnv(): boolean {
    return Boolean(this.o.apiKeyFromEnv);
  }

  /** ringFromEnv reports whether FMRL_RING supplies the ring. */
  get ringFromEnv(): boolean {
    return this.o.ringFromEnv !== undefined;
  }

  async getKey(): Promise<string> {
    if (this.o.apiKeyFromEnv) return this.o.apiKeyFromEnv;
    if (this.cached) return this.cached;
    const stored = (await readCredentials(this.o.file, this.o.log)).keys[this.o.baseUrl];
    if (stored?.key) {
      this.cached = stored.key;
      return stored.key;
    }
    return this.mintOnce();
  }

  /**
   * withKey runs fn with the key, replacing a stored key once on a 401.
   * replaceRevoked: false lets a 401 key_revoked through instead, for a
   * caller that reports the revocation rather than papering over it.
   */
  async withKey<T>(fn: (key: string) => Promise<T>, { replaceRevoked = true }: { replaceRevoked?: boolean } = {}): Promise<T> {
    const key = await this.getKey();
    try {
      return await fn(key);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401 && !this.o.apiKeyFromEnv && (replaceRevoked || e.code !== "key_revoked")) {
        const fresh = await this.mintOnce();
        return fn(fresh);
      }
      throw e;
    }
  }

  /**
   * ringFor is the ring key's private pages are sealed under: FMRL_RING when
   * set, else the one the file keeps for key, else a fresh one — written to
   * the file before it is returned, so nothing is ever sealed under a ring
   * the file does not hold. Concurrent calls for one key share one mint.
   * Throws when the file cannot be written.
   */
  ringFor(key: string): Promise<string> {
    if (this.o.ringFromEnv) return Promise.resolve(this.o.ringFromEnv);
    let p = this.ringPending.get(key);
    if (!p) {
      p = this.loadOrMintRing(key).finally(() => this.ringPending.delete(key));
      this.ringPending.set(key, p);
    }
    return p;
  }

  /** ringsFor lists every ring that may open a record on key's pages, the one ringFor would seal under first. It never mints. */
  async ringsFor(key: string): Promise<string[]> {
    const file = await readCredentials(this.o.file, this.o.log);
    const all = [this.o.ringFromEnv, storedRing(file, this.o.baseUrl, key), ...Object.values(file.rings ?? {})];
    return [...new Set(all.filter(isRing))];
  }

  private loadOrMintRing(key: string): Promise<string> {
    return this.serialize(async () => {
      const file = await readCredentials(this.o.file, this.o.log);
      const found = storedRing(file, this.o.baseUrl, key);
      if (found) return found;
      const ring = newRing();
      const entry = file.keys[this.o.baseUrl];
      if (entry?.key === key) entry.ring = ring;
      else file.rings = { ...file.rings, [prefixOf(key)]: ring };
      await writeCredentials(this.o.file, file);
      this.o.log?.(`fmrl-mcp: minted a key ring for ${prefixOf(key)}…, saved to ${this.o.file}`);
      return ring;
    });
  }

  /**
   * adopt makes key (from a key code or a rotation) the stored key for this
   * base URL, and this process's key from now on, even when the file can't
   * be written (then it throws, and the caller must hand the key over).
   * The prefix is fixed at mint and survives rotation, so a key under the
   * stored prefix is the same key: it keeps its ring and created_at. Any
   * other key's ring moves under its prefix, as a replaced key's does on a
   * mint; rings already filed by prefix stay where they are, so a ring filed
   * under the adopted key's prefix is the one it seals under. It returns the
   * prefix of a different key it replaced.
   */
  async adopt(key: string, prefix: string): Promise<{ replaced?: string }> {
    // A mint in flight would land after this and overwrite it.
    await this.pending?.catch(() => undefined);
    this.cached = key;
    return this.serialize(async () => {
      const file = await readCredentials(this.o.file, this.o.log);
      const old = file.keys[this.o.baseUrl];
      const oldPrefix = old ? old.prefix || prefixOf(old.key) : undefined;
      let replaced: string | undefined;
      if (old && oldPrefix === prefix) {
        file.keys[this.o.baseUrl] = { ...old, key, prefix };
      } else {
        if (old && isRing(old.ring)) file.rings = { ...file.rings, [oldPrefix!]: old.ring };
        file.keys[this.o.baseUrl] = { key, prefix };
        replaced = oldPrefix;
      }
      await writeCredentials(this.o.file, file);
      this.o.log?.(`fmrl-mcp: saved key ${prefix}… for ${this.o.baseUrl} to ${this.o.file}`);
      return { replaced };
    });
  }

  /** mintOnce collapses concurrent mint calls into a single in-flight request. */
  private mintOnce(): Promise<string> {
    return (this.pending ??= this.mint().finally(() => { this.pending = undefined; }));
  }

  private async mint(): Promise<string> {
    const minted = await this.o.api.mint(MINT_LABEL);
    await this.serialize(async () => {
      const file = await readCredentials(this.o.file, this.o.log);
      // A replaced key's ring stays, under its prefix: its pages still exist,
      // and their sealed records open only under it.
      const old = file.keys[this.o.baseUrl];
      if (old && isRing(old.ring)) file.rings = { ...file.rings, [old.prefix || prefixOf(old.key)]: old.ring };
      file.keys[this.o.baseUrl] = { key: minted.key, prefix: minted.prefix, created_at: minted.created_at };
      await writeCredentials(this.o.file, file);
    });
    this.cached = minted.key;
    this.o.log?.(`fmrl-mcp: minted key ${minted.prefix}… for ${this.o.baseUrl}, saved to ${this.o.file}`);
    return minted.key;
  }
}
