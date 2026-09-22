import { openEnvelope, openRecord } from "./crypto.js";
import type { PageRef } from "./ids.js";
import type { PageSecrets, PageStore } from "./pages.js";

/** KeyFrom says where the key that opened a private page came from: the link the caller was handed, this machine's page store, or the page's sealed record under one of this key's rings. */
export type KeyFrom = "link" | "stored" | "ring";

/** OpenedPage is a private page opened here: the content key that did it, where that key came from, the decrypted document, and the title its sealed record carries when the ring opened it. */
export interface OpenedPage { key: string; from: KeyFrom; html: string; title?: string }

export interface OpenerDeps {
  pages: PageStore;
  /** rings is this API key's rings, newest first; asked for only when neither the link nor the store opens the page. */
  rings: () => Promise<string[]>;
  log?: (line: string) => void;
}

async function tryOpen(envelope: string, key: string): Promise<string | undefined> {
  try {
    return await openEnvelope(envelope, { key });
  } catch {
    return undefined;
  }
}

/**
 * openPrivatePage finds a key that opens a private page's envelope: the
 * link's #p= key, else the key this machine's page store holds for the page,
 * else the key in the page's sealed record under one of this key's rings.
 * Each candidate is proved by actually opening envelope, never taken on its
 * shape. A link key that opens it is remembered with the link's manage
 * token (a stored manage token is never replaced by one from a link, which
 * anyone can craft); a key that does not is forgotten. Undefined when no key
 * this machine can reach opens the page. The key never leaves this machine,
 * and nothing here logs it.
 */
export async function openPrivatePage(ref: PageRef, envelope: string, sealed: string | undefined, deps: OpenerDeps): Promise<OpenedPage | undefined> {
  let stored: PageSecrets = {};
  try {
    stored = await deps.pages.get(ref.id);
  } catch (e) {
    deps.log?.(`fmrl-mcp: couldn't read the page store: ${e instanceof Error ? e.message : String(e)}`);
  }

  if (ref.key) {
    const html = await tryOpen(envelope, ref.key);
    if (html !== undefined) {
      try {
        await deps.pages.remember(ref.id, { key: ref.key, manage: stored.manage ? undefined : ref.manage });
      } catch (e) {
        // Reading the page must not fail because it couldn't be remembered.
        deps.log?.(`fmrl-mcp: couldn't remember page ${ref.id}: ${e instanceof Error ? e.message : String(e)}`);
      }
      return { key: ref.key, from: "link", html };
    }
  }

  if (stored.key && stored.key !== ref.key) {
    const html = await tryOpen(envelope, stored.key);
    if (html !== undefined) return { key: stored.key, from: "stored", html };
  }

  if (sealed) {
    for (const ring of await deps.rings()) {
      let record;
      try {
        record = await openRecord(ring, sealed);
      } catch {
        continue; // Not this ring.
      }
      const html = await tryOpen(envelope, record.key);
      if (html !== undefined) return { key: record.key, from: "ring", html, title: record.title };
    }
  }
  return undefined;
}
