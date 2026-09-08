import { ApiError, type FmrlApi } from "./api.js";
import { readCredentials, writeCredentials } from "./credentials.js";

export interface KeyStoreOptions {
  api: FmrlApi;
  baseUrl: string;
  file: string;
  apiKeyFromEnv?: string;
  log?: (line: string) => void;
}

const LABEL = "fmrl-mcp";

/**
 * KeyStore resolves the key every call uses: FMRL_API_KEY when set, else the
 * credentials file's entry for this base URL, else a freshly minted key that
 * is saved for next time. A stored key that answers 401 (revoked, or a
 * preview whose memory store restarted) is replaced once and the call
 * retried; a key from the environment is never replaced.
 */
export class KeyStore {
  private cached?: string;
  private pending?: Promise<string>;
  constructor(private readonly o: KeyStoreOptions) {}

  async getKey(): Promise<string> {
    if (this.o.apiKeyFromEnv) return this.o.apiKeyFromEnv;
    if (this.cached) return this.cached;
    const stored = (await readCredentials(this.o.file)).keys[this.o.baseUrl];
    if (stored?.key) {
      this.cached = stored.key;
      return stored.key;
    }
    return this.mintOnce();
  }

  async withKey<T>(fn: (key: string) => Promise<T>): Promise<T> {
    const key = await this.getKey();
    try {
      return await fn(key);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401 && !this.o.apiKeyFromEnv) {
        const fresh = await this.mintOnce();
        return fn(fresh);
      }
      throw e;
    }
  }

  /** mintOnce collapses concurrent mint calls into a single in-flight request. */
  private mintOnce(): Promise<string> {
    return (this.pending ??= this.mint().finally(() => { this.pending = undefined; }));
  }

  private async mint(): Promise<string> {
    const minted = await this.o.api.mint(LABEL);
    const file = await readCredentials(this.o.file);
    file.keys[this.o.baseUrl] = { key: minted.key, prefix: minted.prefix, created_at: minted.created_at };
    await writeCredentials(this.o.file, file);
    this.cached = minted.key;
    this.o.log?.(`fmrl-mcp: minted key ${minted.prefix}… for ${this.o.baseUrl}, saved to ${this.o.file}`);
    return minted.key;
  }
}
