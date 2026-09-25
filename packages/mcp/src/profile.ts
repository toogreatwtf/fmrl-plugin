import { Marked, type Tokens } from "marked";
import { PROFILE_TYPE, decodeEntities, scriptBlocks, stripTags } from "./markdown.js";

/**
 * A canvas profile is a page's agreed section shape, carried in the page
 * itself as an inert fmrl-profile block: a ```fmrl-profile fence in Markdown,
 * which renders as <script type="application/fmrl-profile+json">. The server
 * never reads it (a private page's is sealed); this reads it here, after
 * decrypting, and says which heading holds each section.
 */
export type ProfileSection = { id: string; purpose: string; by: string; required: boolean };
export type Profile = { profile: string; v: number; sections: ProfileSection[]; norms: string[] };
export type SectionMap = Record<string, { heading: string; position: number }>;
export type ProfileRead = { profile?: Profile; section_map?: SectionMap; missing?: string[]; profile_error?: string };

/** slug lowercases text and joins every run outside [a-z0-9] with one dash, trimming dashes at the ends. */
export function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

const md = new Marked({ gfm: true, async: false });

type Heading = { text: string; start: number };
type Found = { body: string; headings: Heading[]; marks: Array<{ id: string; at: number }> };

const plain = (html: string) => decodeEntities(stripTags(html).replace(/\s+/g, " ").trim());

type AnyToken = { type: string; tokens?: AnyToken[]; items?: AnyToken[] };

/**
 * walkMarkdownTokens visits every token in document order: each token, then
 * its children (a blockquote's or list item's `tokens`, a list's `items`)
 * before its next sibling. A `code` token's `text` is raw fence content, not
 * Markdown, so its children — it has none, but a future extension might add
 * some — are never walked.
 */
function walkMarkdownTokens(tokens: AnyToken[], visit: (t: AnyToken) => void): void {
  for (const t of tokens) {
    visit(t);
    if (t.type === "code") continue;
    if (t.tokens) walkMarkdownTokens(t.tokens, visit);
    if (t.items) walkMarkdownTokens(t.items, visit);
  }
}

function fromMarkdown(content: string): Found | undefined {
  const tokens = md.lexer(content) as unknown as AnyToken[];
  let block: Tokens.Code | undefined;
  const headings: Heading[] = [];
  walkMarkdownTokens(tokens, (t) => {
    if (t.type === "code") {
      if (block) return;
      const code = t as unknown as Tokens.Code;
      if (/^\S*/.exec(code.lang ?? "")?.[0] === "fmrl-profile") block = code;
      return;
    }
    if (t.type === "heading") {
      const heading = t as unknown as Tokens.Heading;
      headings.push({ text: plain(md.parseInline(heading.text) as string), start: headings.length });
    }
  });
  if (!block) return undefined;
  return { body: block.text, headings, marks: [] };
}

const TYPE_ATTR = /(?:^|\s)type\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i;
const MARK_ATTR = /\sdata-fmrl-section\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/;
const HIDDEN = /<!--|<(script|style)\b/gi;
const CLOSE: Record<string, RegExp> = { script: /<\/script\s*>/gi, style: /<\/style\s*>/gi };

/**
 * blank replaces with spaces what a browser never reads as markup — the
 * bodies of <script> and <style>, and whole <!-- --> comments — so headings
 * and marks inside them are not found, and every offset stays where it was.
 * An unclosed comment or body runs to the end, as it does in a browser. One
 * left-to-right pass, so "<!--" inside a script is not a comment, nor a
 * "<script" inside a comment a script.
 */
function blank(html: string): string {
  let out = "";
  let i = 0;
  const hide = (from: number, to: number) => { out += html.slice(i, from) + " ".repeat(to - from); i = to; };
  for (;;) {
    HIDDEN.lastIndex = i;
    const m = HIDDEN.exec(html);
    if (!m) break;
    if (m[0] === "<!--") {
      const end = html.indexOf("-->", m.index + 4);
      hide(m.index, end < 0 ? html.length : end + 3);
      continue;
    }
    const gt = html.indexOf(">", m.index + m[0].length);
    if (gt < 0) break;
    const close = CLOSE[m[1].toLowerCase()];
    close.lastIndex = gt + 1;
    const c = close.exec(html);
    hide(gt + 1, c ? c.index : html.length);
    if (c) { out += html.slice(i, c.index + c[0].length); i = c.index + c[0].length; }
  }
  return out + html.slice(i);
}

/**
 * headingsOf is every <h1>…</h1> to <h6>…</h6> in document order, as
 * /<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1\s*>/gi finds them, in linear time. A
 * start tag with no ">" after it ends the scan. The last ">" found, and each
 * level's next close, are remembered while they still lie ahead, so a page of
 * unclosed <h2 tags with one far ">", or of <h2> with no close, is not
 * rescanned from every one.
 */
function headingsOf(html: string): Heading[] {
  const open = /<h([1-6])\b/gi;
  const closes = new Map<string, { re: RegExp; at: number; len: number }>();
  const closeFor = (level: string, from: number) => {
    let c = closes.get(level);
    if (!c) { c = { re: new RegExp(`<\\/h${level}\\s*>`, "gi"), at: 0, len: 0 }; closes.set(level, c); c.at = from - 1; }
    // at < from: search again from here; at === -Infinity: none left anywhere after an earlier point.
    if (c.at !== -Infinity && c.at < from) {
      c.re.lastIndex = from;
      const m = c.re.exec(html);
      c.at = m ? m.index : -Infinity;
      c.len = m ? m[0].length : 0;
    }
    return c.at === -Infinity ? undefined : c;
  };
  const out: Heading[] = [];
  let from = 0;
  // gt is the first ">" at or after some earlier point; while it lies at or after this tag's name, it is this tag's too.
  let gt = -1;
  for (;;) {
    open.lastIndex = from;
    const o = open.exec(html);
    if (!o) break;
    if (gt < o.index + o[0].length) gt = html.indexOf(">", o.index + o[0].length);
    if (gt < 0) break;
    const c = closeFor(o[1], gt + 1);
    if (!c) { from = o.index + o[0].length; continue; }
    out.push({ text: plain(html.slice(gt + 1, c.at)), start: o.index });
    from = c.at + c.len;
  }
  return out;
}

/** marksOf is each start tag's data-fmrl-section value and where the tag starts, found with indexOf rather than a backtracking regex. */
function marksOf(html: string): Array<{ id: string; at: number }> {
  const out: Array<{ id: string; at: number }> = [];
  let i = 0;
  for (;;) {
    const lt = html.indexOf("<", i);
    if (lt < 0) break;
    if (!/[A-Za-z]/.test(html[lt + 1] ?? "")) { i = lt + 1; continue; }
    const gt = html.indexOf(">", lt + 1);
    if (gt < 0) break;
    const m = MARK_ATTR.exec(html.slice(lt, gt));
    if (m) out.push({ id: m[1] ?? m[2] ?? m[3], at: lt });
    i = gt + 1;
  }
  return out;
}

function fromHTML(content: string): Found | undefined {
  let body: string | undefined;
  for (const s of scriptBlocks(content)) {
    const t = TYPE_ATTR.exec(s.attrs);
    if (t && (t[1] ?? t[2] ?? t[3]) === PROFILE_TYPE) { body = s.body; break; }
  }
  if (body === undefined) return undefined;
  const visible = blank(content);
  return { body, headings: headingsOf(visible), marks: marksOf(visible) };
}

/** lowerBound is the first index in [0, n) where the monotone test holds, or n. */
function lowerBound(n: number, test: (i: number) => boolean): number {
  let lo = 0, hi = n;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (test(mid)) hi = mid; else lo = mid + 1;
  }
  return lo;
}

/**
 * FirstUnclaimed is a min segment tree over headings in slug order: first(lo,
 * hi) is the smallest unclaimed heading index among slug ranks [lo, hi), or
 * -1, and remove(i) claims heading i; both O(log n).
 */
class FirstUnclaimed {
  private readonly size: number;
  private readonly min: Float64Array;
  private readonly rank: Int32Array;
  constructor(order: number[], claimed: Uint8Array) {
    let size = 1;
    while (size < order.length) size *= 2;
    this.size = size;
    this.min = new Float64Array(2 * size).fill(Infinity);
    this.rank = new Int32Array(order.length);
    order.forEach((h, r) => { this.rank[h] = r; if (!claimed[h]) this.min[size + r] = h; });
    for (let p = size - 1; p >= 1; p--) this.min[p] = Math.min(this.min[2 * p], this.min[2 * p + 1]);
  }
  remove(h: number): void {
    let p = this.size + this.rank[h];
    this.min[p] = Infinity;
    for (p >>= 1; p >= 1; p >>= 1) this.min[p] = Math.min(this.min[2 * p], this.min[2 * p + 1]);
  }
  first(lo: number, hi: number): number {
    let m = Infinity;
    for (let l = lo + this.size, r = hi + this.size; l < r; l >>= 1, r >>= 1) {
      if (l & 1) m = Math.min(m, this.min[l++]);
      if (r & 1) m = Math.min(m, this.min[--r]);
    }
    return m === Infinity ? -1 : m;
  }
}

/** parse reads a profile block's JSON into a Profile, or says why it is not one. */
function parse(body: string): Profile | string {
  let v: unknown;
  try { v = JSON.parse(body); } catch (e) {
    return `the fmrl-profile block is not valid JSON: ${e instanceof Error ? e.message : String(e)}`;
  }
  const not = (why: string) => `the fmrl-profile block is not a profile: ${why}`;
  if (typeof v !== "object" || v === null || Array.isArray(v)) return not("it is not an object");
  const o = v as Record<string, unknown>;
  if (!Array.isArray(o.sections)) return not("sections is not an array");
  const sections: ProfileSection[] = [];
  const seen = new Set<string>();
  for (const [i, s] of o.sections.entries()) {
    if (typeof s !== "object" || s === null || Array.isArray(s)) return not(`section ${i + 1} is not an object`);
    const r = s as Record<string, unknown>;
    if (typeof r.id !== "string" || r.id === "") return not(`section ${i + 1} has no id`);
    // A repeated id is the first one's: it is looked for, and missed, once.
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    sections.push({
      id: r.id,
      purpose: typeof r.purpose === "string" ? r.purpose : "",
      by: typeof r.by === "string" ? r.by : "",
      required: r.required === true,
    });
  }
  return {
    profile: typeof o.profile === "string" ? o.profile : "",
    v: typeof o.v === "number" ? o.v : 0,
    sections,
    norms: Array.isArray(o.norms) ? o.norms.filter((n): n is string => typeof n === "string") : [],
  };
}

/**
 * readProfile reads a page's profile block and maps its sections to
 * headings: explicit data-fmrl-section marks first (HTML only), then an
 * exact slug match, then a slug that starts with the id and a dash. It is {}
 * when the content has no block, and { profile_error } when the block is
 * there but unreadable.
 */
export function readProfile(content: string, format: "html" | "md"): ProfileRead {
  const found = format === "md" ? fromMarkdown(content) : fromHTML(content);
  if (!found) return {};
  const profile = parse(found.body);
  if (typeof profile === "string") return { profile_error: profile };

  const ids = new Set(profile.sections.map((s) => s.id));
  const { headings } = found;
  const claimed = new Uint8Array(headings.length);
  // A Map, not an object: an id may be "__proto__" or "toString".
  const map = new Map<string, { heading: string; position: number }>();
  let onClaim = (_i: number) => {};
  const claim = (id: string, i: number) => {
    claimed[i] = 1;
    onClaim(i);
    map.set(id, { heading: headings[i].text, position: i + 1 });
  };
  // Marks: the first heading at or after the mark (headings are in document order), when it is still unclaimed.
  for (const { id, at } of found.marks) {
    if (!ids.has(id) || map.has(id)) continue;
    const i = lowerBound(headings.length, (j) => headings[j].start >= at);
    if (i < headings.length && !claimed[i]) claim(id, i);
  }
  // Slugs: sort the headings by slug, so the headings whose slug equals X, or
  // starts with X + "-", are one run of that order; a min-tree over the run
  // gives the first unclaimed heading in document order.
  const slugs = headings.map((h) => slug(h.text));
  const order = slugs.map((_, i) => i).sort((a, b) => (slugs[a] < slugs[b] ? -1 : slugs[a] > slugs[b] ? 1 : a - b));
  const tree = new FirstUnclaimed(order, claimed);
  onClaim = (i) => tree.remove(i);
  const run = (lo: string, hi: string) => tree.first(
    lowerBound(order.length, (r) => slugs[order[r]] >= lo),
    lowerBound(order.length, (r) => slugs[order[r]] >= hi),
  );
  // Slugs hold no "\0", so [X, X + "\0") is X alone; "-" is followed by ".", so [X + "-", X + ".") is every slug starting X + "-".
  const passes: Array<(id: string) => number> = [(id) => run(id, id + "\0"), (id) => run(id + "-", id + ".")];
  for (const find of passes) {
    for (const { id } of profile.sections) {
      if (map.has(id)) continue;
      const i = find(id);
      if (i >= 0) claim(id, i);
    }
  }
  const missing = profile.sections.map((s) => s.id).filter((id) => !map.has(id));
  // Object.fromEntries defines own properties, so a "__proto__" id is a key, not the prototype.
  return { profile, section_map: Object.fromEntries(map), missing };
}
