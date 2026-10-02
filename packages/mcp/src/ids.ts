import { PAGE_KEY_SHAPE } from "./crypto.js";

/** ID is a minted page id: 12 characters of the doc alphabet (lowercase Crockford base32). */
const ID = /^[0-9abcdefghjkmnpqrstvwxyz]{12}$/;
/**
 * SLUG is a house page's id — the pages fmrl.site carries in the binary and
 * serves at short ids, like h4ndrv (the handoff-review starter profile) or
 * q7m2xk (the demo canvas): 4 to 11 characters of the same alphabet. A minted
 * id is always 12, so the two namespaces never meet (markymd internal/reserved).
 */
const SLUG = /^[0-9abcdefghjkmnpqrstvwxyz]{4,11}$/;
/** MANAGE_TOKEN_SHAPE is a manage link's token: 22 base64url characters. */
const MANAGE_TOKEN_SHAPE = /^[A-Za-z0-9_-]{22}$/;

/** PAGE_HOST is the host whose links always name a page; the configured base URL (a preview, fmrl.test) is the other. */
const PAGE_HOST = "fmrl.site";

/** RefOptions says which other host serves pages: the configured base URL, when it isn't fmrl.site. */
export interface RefOptions {
  /** base is the configured base URL (FMRL_API_URL), whose host also serves pages. */
  base?: string;
}

function hostOf(s: string | undefined): string | undefined {
  if (s === undefined) return undefined;
  try {
    return new URL(s).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

/**
 * extractId finds a page id in input: the whole (trimmed) string, when it is
 * a minted id or a house page's slug; or, read as a URL, any path segment
 * that is a minted id (a viewer, raw, revision, manage or edit link on any
 * host — previews included); or, on fmrl.site or the configured base's host
 * only, a slug at the root of the path (/{slug}, /{slug}/raw). A slug
 * is a word-shaped thing, so it is taken from a URL only when the host is
 * one that serves pages; a minted id is not, so it is taken from any URL.
 * Returns undefined rather than throwing, so callers can choose their own error.
 */
function extractId(input: string, opts: RefOptions = {}): string | undefined {
  const s = input.trim();
  if (ID.test(s) || SLUG.test(s)) return s;
  let url: URL | undefined;
  try {
    url = new URL(s);
  } catch {
    url = undefined;
  }
  if (!url) return undefined;
  const segs = url.pathname.split("/").filter((seg) => seg !== "");
  for (const seg of segs) {
    if (ID.test(seg)) return seg;
  }
  // A house page is served at /{slug} and /{slug}/raw, nowhere deeper: a
  // manage or edit path with no minted id in it names no page.
  const host = url.hostname.toLowerCase();
  const atRoot = segs.length === 1 || (segs.length === 2 && segs[1] === "raw");
  if (atRoot && (host === PAGE_HOST || host === hostOf(opts.base))) {
    const first = segs[0];
    if (first !== undefined && SLUG.test(first)) return first;
  }
  return undefined;
}

/** withoutFragment is input up to its first "#": what a refusal may repeat, since a fragment can carry a page key or a manage token. */
function withoutFragment(input: string): string {
  const s = input.trim();
  const i = s.indexOf("#");
  return i === -1 ? s : s.slice(0, i);
}

/** parseDocId accepts a page id or a house page's slug, bare or in a fmrl URL (see extractId). */
export function parseDocId(input: string, opts: RefOptions = {}): string {
  const id = extractId(input, opts);
  if (id !== undefined) return id;
  throw new Error(`${JSON.stringify(withoutFragment(input))} is not a document id or a fmrl.site URL.`);
}

export interface PageRef {
  id: string;
  key?: string;
  manage?: string;
}

/**
 * parsePageRef accepts a bare id, or any fmrl URL that contains one as a path
 * segment — a viewer link (/{id}), a revision link (/{id}/rev/3), a manage
 * link (/manage/{id}) or an edit link (/edit/{id}) — with or without a
 * trailing fragment carrying a page key (p=<43 base64url characters>) and/or
 * a manage token (k=<22 base64url characters>), &-separated in either order.
 * A house page's slug (h4ndrv) counts as an id, bare or at the root of a
 * fmrl.site link or one on opts.base's host (see extractId).
 * A malformed p or k, an unrelated field, or a field with no value is
 * dropped rather than rejected: only the id must be valid.
 */
export function parsePageRef(input: string, opts: RefOptions = {}): PageRef {
  const trimmed = input.trim();
  const hashIdx = trimmed.indexOf("#");
  const main = hashIdx === -1 ? trimmed : trimmed.slice(0, hashIdx);
  const fragment = hashIdx === -1 ? "" : trimmed.slice(hashIdx + 1);

  const id = extractId(main, opts);
  if (id === undefined) {
    throw new Error(`${JSON.stringify(main)} is not a page id or a fmrl.site URL.`);
  }

  const ref: PageRef = { id };
  if (fragment !== "") {
    for (const part of fragment.split("&")) {
      const eq = part.indexOf("=");
      if (eq === -1) continue;
      const name = part.slice(0, eq);
      const value = part.slice(eq + 1);
      if (name === "p" && PAGE_KEY_SHAPE.test(value)) ref.key = value;
      else if (name === "k" && MANAGE_TOKEN_SHAPE.test(value)) ref.manage = value;
    }
  }
  return ref;
}
