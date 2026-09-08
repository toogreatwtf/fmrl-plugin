const ID = /^[0-9abcdefghjkmnpqrstvwxyz]{12}$/;

/** parseDocId accepts a 12-character document id or any fmrl URL that contains one as a path segment. */
export function parseDocId(input: string): string {
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
  throw new Error(`${JSON.stringify(input)} is not a document id or a fmrl.site URL.`);
}
