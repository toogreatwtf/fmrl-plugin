// Private pages a person lends their agent. An agent attached to a person
// edits what that person can, but a private page opens only with its key,
// and those live with the people who hold them. So the agent asks once, with
// a link its person opens: their browser seals their key rings, and the keys
// of private pages shared with them, under this agent's own ring, and
// fmrl.site keeps them without being able to open any. Here the agent reads
// them back (GET /me/lent) and opens each with its own ring.
//
// Lent rings are kept in memory only, for a minute at a time: fmrl.site
// stops serving them the moment the agent is detached, and nothing here
// writes them to disk.

import { ApiError, type FmrlApi, type LendLink, type LendState } from "./api.js";
import { isRing, openRecord } from "./crypto.js";

export interface LentRingsOptions {
  api: FmrlApi;
  /** ownRings is this key's own rings, the ones a lent ring is sealed under. */
  ownRings: (key: string) => Promise<string[]>;
  ttlMs?: number;
  now?: () => number;
  log?: (line: string) => void;
}

/** LentRings reads and opens the rings a key's person lent it, keeping them in memory for a short while. */
export class LentRings {
  private readonly cache = new Map<string, { at: number; rings: Promise<Map<string, string>> }>();
  private readonly ttl: number;
  private readonly now: () => number;

  constructor(private readonly o: LentRingsOptions) {
    this.ttl = o.ttlMs ?? 60_000;
    this.now = o.now ?? Date.now;
  }

  /** forget drops what is kept for key, so the next read asks fmrl.site again: after a lend, say. */
  forget(key: string): void {
    this.cache.delete(key);
  }

  /** get maps each ring id the person lent key to the ring itself. Empty when nothing was lent, the agent isn't attached, or the server has no such route. */
  get(key: string): Promise<Map<string, string>> {
    const hit = this.cache.get(key);
    if (hit && this.now() - hit.at < this.ttl) return hit.rings;
    const rings = this.read(key);
    this.cache.set(key, { at: this.now(), rings });
    // A failed read is not kept: the next call tries again.
    rings.catch(() => this.cache.delete(key));
    return rings;
  }

  /** ringsFor lists the lent rings to try on a record, the one hint names first. */
  async ringsFor(key: string, hint?: string): Promise<string[]> {
    const rings = await this.get(key);
    const first = hint ? rings.get(hint) : undefined;
    return first ? [first, ...[...rings.values()].filter((r) => r !== first)] : [...rings.values()];
  }

  private async read(key: string): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    let rows: unknown;
    try {
      rows = (await this.o.api.lent(key))?.rings;
    } catch (e) {
      // Not attached (403), nothing to serve or an older server (404): nothing lent.
      if (e instanceof ApiError && (e.status === 403 || e.status === 404)) return out;
      throw e;
    }
    if (!Array.isArray(rows)) return out;
    const own = await this.o.ownRings(key);
    for (const row of rows) {
      if (!row || typeof row !== "object") continue;
      const { ring: id, box } = row as { ring?: unknown; box?: unknown };
      if (typeof id !== "string" || typeof box !== "string") continue;
      for (const mine of own) {
        try {
          const rec = await openRecord(mine, box);
          // The record names the ring it holds; one that names another is not this ring.
          if (rec.title === id && isRing(rec.key)) out.set(id, rec.key);
          break;
        } catch {
          // Not this ring.
        }
      }
    }
    return out;
  }
}

/** LendAsk is what asking the person for their private pages came to: a link to hand them, or why there is none. */
export type LendAsk =
  | { kind: "link"; url: string; expires_at: string }
  | { kind: "declined" }
  | { kind: "refused"; code: string; message: string };

export interface LenderOptions {
  api: FmrlApi;
  /** syncRings uploads this key's ring to its person's vault, which a lend needs; true when it got there. */
  syncRings: (key: string) => Promise<boolean>;
  now?: () => number;
}

/**
 * Lender asks for a lend: it mints the link, first uploading this key's ring
 * when the person's account doesn't hold it yet, and keeps the link it made
 * so a second ask while the first is live hands out the same one rather
 * than spending another.
 */
export class Lender {
  private readonly links = new Map<string, LendLink>();
  private readonly attachment = new Map<string, number>();
  private readonly minting = new Map<string, Promise<LendAsk>>();
  private readonly now: () => number;

  constructor(private readonly o: LenderOptions) {
    this.now = o.now ?? Date.now;
  }

  /**
   * attached is whether key is attached to a person, from GET /me: an agent
   * attached to no one has nobody to ask. Only a yes is kept, for a minute;
   * the person may attach it any moment, from their browser. Undefined when
   * that can't be told, and then the lend routes decide.
   */
  private async attached(key: string): Promise<boolean | undefined> {
    const at0 = this.attachment.get(key);
    if (at0 !== undefined && this.now() - at0 < 60_000) return true;
    let at: unknown;
    try {
      at = (await this.o.api.me(key))?.attached_at;
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) throw e;
      return undefined;
    }
    if (at === undefined) return undefined;
    const attached = typeof at === "string" && at !== "";
    if (attached) this.attachment.set(key, this.now());
    else this.attachment.delete(key);
    return attached;
  }

  /** state is the lend link's state; undefined from a server with no such route, or for an agent attached to no one. */
  async state(key: string): Promise<LendState | undefined> {
    if (await this.attached(key) === false) return undefined;
    try {
      const s = await this.o.api.lendState(key);
      return s && typeof s.status === "string" ? s : undefined;
    } catch (e) {
      if (e instanceof ApiError && (e.status === 403 || e.status === 404)) return undefined;
      throw e;
    }
  }

  /** live is the link this process made for key, while it is still pending. */
  private live(key: string, state: LendState | undefined): LendLink | undefined {
    const link = this.links.get(key);
    if (!link || state?.status !== "pending") return undefined;
    return Date.parse(link.expires_at) - this.now() > 30_000 ? link : undefined;
  }

  /** ask hands back a link for the person: the live one this process made, else a new one. force skips a "Not now" the person gave. */
  async ask(key: string, opts: { force?: boolean; state?: LendState } = {}): Promise<LendAsk> {
    const state = opts.state ?? await this.state(key);
    if (!opts.force && state?.status === "declined") return { kind: "declined" };
    const live = this.live(key, state);
    if (live) return { kind: "link", ...live };
    // A link replaces the one before it, so asks that overlap share one mint rather than each spending a link.
    const pending = this.minting.get(key);
    if (pending) return pending;
    const mint = this.mint(key).finally(() => this.minting.delete(key));
    this.minting.set(key, mint);
    return mint;
  }

  private async mint(key: string): Promise<LendAsk> {
    let synced = false;
    for (;;) {
      try {
        const link = await this.o.api.lend(key);
        if (!link || typeof link.url !== "string") return { kind: "refused", code: "internal", message: "fmrl.site answered without a link; try again." };
        this.links.set(key, link);
        return { kind: "link", url: link.url, expires_at: link.expires_at };
      } catch (e) {
        if (!(e instanceof ApiError)) throw e;
        if (e.code === "not_claimed") this.attachment.delete(key);
        // The person's account needs this key's ring before their browser can seal under it: send it once, then ask again.
        if (e.code === "ring_missing" && !synced) {
          synced = true;
          if (await this.o.syncRings(key)) continue;
        }
        if (e.status === 401) throw e;
        return { kind: "refused", code: e.code, message: e.message };
      }
    }
  }

  /** forget drops the link kept for key, and whether it is attached: the link was used, or ran out. */
  forget(key: string): void {
    this.links.delete(key);
    this.attachment.delete(key);
  }
}
