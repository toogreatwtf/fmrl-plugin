import { PAGE_KEY_SHAPE } from "./crypto.js";

const ID = /^[0-9abcdefghjkmnpqrstvwxyz]{12}$/;
/** MANAGE_TOKEN_SHAPE is a manage link's token: 22 base64url characters. */
const MANAGE_TOKEN_SHAPE = /^[A-Za-z0-9_-]{22}$/;

/** extractId finds a 12-character document id: the whole (trimmed) string, or a path segment of it read as a URL. Returns undefined rather than throwing, so callers can choose their own error. */
function extractId(input: string): string | undefined {
  const s = input.trim();
  if (ID.test(s)) return s;
  let url: URL | undefined;
  try {
    url = new URL(s);
  } catch {
    url = undefined;
  }
  if (url) {
    for (const seg of url.pathname.split("/")) {
      if (ID.test(seg)) return seg;
    }
  }
  return undefined;
}

/** parseDocId accepts a 12-character document id or any fmrl URL that contains one as a path segment. */
export function parseDocId(input: string): string {
  const id = extractId(input);
  if (id !== undefined) return id;
  throw new Error(`${JSON.stringify(input)} is not a document id or a fmrl.site URL.`);
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
 * A malformed p or k, an unrelated field, or a field with no value is
 * dropped rather than rejected: only the id must be valid.
 */
export function parsePageRef(input: string): PageRef {
  const trimmed = input.trim();
  const hashIdx = trimmed.indexOf("#");
  const main = hashIdx === -1 ? trimmed : trimmed.slice(0, hashIdx);
  const fragment = hashIdx === -1 ? "" : trimmed.slice(hashIdx + 1);

  const id = extractId(main);
  if (id === undefined) {
    throw new Error(`${JSON.stringify(input)} is not a page id or a fmrl.site URL.`);
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
