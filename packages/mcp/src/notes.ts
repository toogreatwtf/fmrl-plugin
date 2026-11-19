// Comments on a private page, done here because only this machine holds the
// page's key. The server stores a private page's comments sealed and reads
// none of them, so placing a comment on the page's words, and reading back
// where a comment sits, happen on the opened page, the way the viewer does it
// in the browser:
//
// - PageText indexes the opened HTML as the viewer's frame does: every text
//   node under <body>, in order, outside script, style, noscript and template
//   elements and anything marked data-fmrl-a, joined with nothing between,
//   with positions in UTF-16 code units (a JavaScript string's own units).
// - find turns an agent's quote into the anchor a person's selection would
//   make (the page's own words, up to 32 characters either side, and where
//   they start), and refuses a quote that fits more than one place or none.
// - locate re-attaches a stored anchor, as the viewer does, to say whether
//   the words are still on the page and under which heading.
// - sealNote and openNote are the viewer's AES-GCM sealing of a comment.
//
// This mirrors fmrl.site's own matching for public pages, so a comment reads
// the same whichever side placed it.

import { parse } from "parse5";
import type { DefaultTreeAdapterMap } from "parse5";
import { toHTML } from "./markdown.js";

type Node = DefaultTreeAdapterMap["node"];
type ParentNode = DefaultTreeAdapterMap["parentNode"];
type Element = DefaultTreeAdapterMap["element"];

/** Anchor is where a comment points: the words, up to 32 characters either side, and where the words start, in UTF-16 units of the page's text. */
export interface Anchor { quote: string; prefix: string; suffix: string; start: number }

/** CONTEXT is how many characters either side of the words an anchor keeps. */
export const CONTEXT = 32;
/** MAX_QUOTE is the longest quote an anchor keeps, in characters. */
export const MAX_QUOTE = 2000;
/** MAX_NOTE_BODY is the longest comment or reply, in characters. */
export const MAX_NOTE_BODY = 2000;
/** MAX_SEALED_NOTE is the longest sealed note the server stores, in characters. */
export const MAX_SEALED_NOTE = 8 << 10;

/** Query is what an agent says about where its comment goes: words from the page, optionally the words just before and after them, and which copy (1 for the first) when they are on the page more than once. */
export interface Query { quote: string; prefix?: string; suffix?: string; occurrence?: number }

/** Place is a quote found on the page: the anchor to store and the nearest heading before it. */
export interface Place { anchor: Anchor; heading: string }

/** QuoteError is a quote that didn't place a comment, worded for the agent as fmrl.site words it for a public page. */
export class QuoteError extends Error {
  constructor(public readonly code: "bad_request" | "quote_ambiguous" | "quote_not_found", message: string) {
    super(message);
    this.name = "QuoteError";
  }
}

const SKIPPED = new Set(["script", "style", "noscript", "template"]);
const HEADINGS = new Set(["h1", "h2", "h3", "h4", "h5", "h6"]);
const MAX_LISTED = 10;
const LOCATE_CANDIDATES = 1000;

// White space as Go's unicode.IsSpace counts it, which is what fmrl.site folds.
function isSpace(c: number): boolean {
  return (c >= 0x09 && c <= 0x0d) || c === 0x20 || c === 0x85 || c === 0xa0 || c === 0x1680 ||
    (c >= 0x2000 && c <= 0x200a) || c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000;
}

/** fold is the character matching compares: white space is a space and a curly quote a straight one. */
function fold(c: number): number {
  if (isSpace(c)) return 0x20;
  if (c === 0x2018 || c === 0x2019 || c === 0x201a || c === 0x201b) return 0x27;
  if (c === 0x201c || c === 0x201d || c === 0x201e || c === 0x201f) return 0x22;
  return c;
}

/** codePoints walks s as code points, a lone surrogate as U+FFFD of one unit, yielding each with its UTF-16 position and size. */
function* codePoints(s: string): Generator<[cp: number, at: number, size: number]> {
  for (let i = 0; i < s.length;) {
    const cp = s.codePointAt(i)!;
    const size = cp > 0xffff ? 2 : 1;
    yield [cp >= 0xd800 && cp <= 0xdfff ? 0xfffd : cp, i, size];
    i += size;
  }
}

/** squash folds s and makes each run of spaces one, trimming the ends. */
export function squash(s: string): string {
  let out = "";
  let space = false;
  for (const [cp] of codePoints(s)) {
    const r = fold(cp);
    if (r === 0x20) {
      space = out.length > 0;
      continue;
    }
    if (space) {
      out += " ";
      space = false;
    }
    out += String.fromCodePoint(r);
  }
  return out;
}

function runeCount(s: string): number {
  let n = 0;
  for (const _ of codePoints(s)) n++;
  return n;
}

function isElement(n: Node): n is Element {
  return "tagName" in n;
}

/** skipped is whether the viewer leaves an element's text out of the page's text. */
function skipped(el: Element): boolean {
  return SKIPPED.has(el.tagName) || el.attrs.some((a) => !a.namespace && a.name === "data-fmrl-a");
}

function findBody(n: ParentNode): Element | undefined {
  for (const c of n.childNodes) {
    if (!isElement(c)) continue;
    if (c.tagName === "body") return c;
    const f = findBody(c);
    if (f) return f;
  }
  return undefined;
}

interface Heading { start: number; text: string }

/** PageText is a page's text as the viewer indexes it, with what matching and locating need. */
export class PageText {
  /** raw is the page's text. */
  readonly raw: string;
  private readonly headings: Heading[];
  // norm is raw folded with each run of spaces made one; at maps each unit of
  // norm to where its character starts in raw, and end to the unit after it.
  private readonly norm: string;
  private readonly at: number[];
  private readonly end: number[];

  private constructor(raw: string, headings: Heading[]) {
    this.raw = raw;
    this.headings = headings;
    let norm = "";
    const at: number[] = [];
    const end: number[] = [];
    for (const [cp, i, size] of codePoints(raw)) {
      const r = fold(cp);
      if (r === 0x20 && norm.endsWith(" ")) {
        end[end.length - 1] = i + size;
        continue;
      }
      const s = String.fromCodePoint(r);
      norm += s;
      for (let k = 0; k < s.length; k++) {
        at.push(i);
        end.push(i + size);
      }
    }
    at.push(raw.length);
    end.push(raw.length);
    this.norm = norm;
    this.at = at;
    this.end = end;
  }

  /** fromHTML indexes a whole HTML document. */
  static fromHTML(html: string): PageText {
    const doc = parse(html);
    const body = findBody(doc);
    let raw = "";
    const headings: Heading[] = [];
    const walk = (n: ParentNode): void => {
      for (const c of n.childNodes) {
        if (c.nodeName === "#text") {
          raw += (c as DefaultTreeAdapterMap["textNode"]).value;
        } else if (isElement(c) && !skipped(c)) {
          const start = raw.length;
          walk(c);
          if (HEADINGS.has(c.tagName)) headings.push({ start, text: squash(raw.slice(start)) });
        }
      }
    };
    if (body) walk(body);
    return new PageText(raw, headings);
  }

  /** slice is raw [from, to), its ends pulled in so it never splits a surrogate pair. */
  private slice(from: number, to: number): string {
    from = Math.max(0, from);
    to = Math.min(this.raw.length, to);
    const u = (i: number) => this.raw.charCodeAt(i);
    if (from < to && from > 0 && u(from) >= 0xdc00 && u(from) <= 0xdfff) from++;
    if (from < to && to < this.raw.length && u(to - 1) >= 0xd800 && u(to - 1) < 0xdc00) to--;
    return from >= to ? "" : this.raw.slice(from, to);
  }

  /** headingAt is the text of the last heading that starts at or before at, "" when none does. */
  headingAt(at: number): string {
    let h = "";
    for (const x of this.headings) {
      if (x.start > at) break;
      h = x.text;
    }
    return h;
  }

  /**
   * find turns q into an anchor, the way a person's selection becomes one:
   * the page's own words with its own 32 characters either side. White space
   * and curly quotes compare loosely, and words not found as given are tried
   * again as Markdown, rendered, so a quote copied from the source lands. It
   * never picks one of several places by itself.
   */
  find(q: Query): Place {
    const quote = squash(q.quote);
    if (quote === "") throw new QuoteError("bad_request", "quote is required: the words on the page the comment is about.");
    if (runeCount(quote) > MAX_QUOTE) throw new QuoteError("bad_request", "quote is over 2000 characters. Quote fewer words.");
    const occurrence = q.occurrence ?? 0;
    if (occurrence < 0 || !Number.isInteger(occurrence)) throw new QuoteError("bad_request", "occurrence must be 1 or more, or left out.");
    const prefix = squash(q.prefix ?? "");
    const suffix = squash(q.suffix ?? "");
    let p = this.findSquashed(quote, prefix, suffix, occurrence);
    if (p) return p;
    // The words as given are nowhere: read them as Markdown.
    const mq = markdownText(q.quote), mp = markdownText(q.prefix ?? ""), ms = markdownText(q.suffix ?? "");
    if (mq !== "" && (mq !== quote || mp !== prefix || ms !== suffix)) {
      p = this.findSquashed(mq, mp, ms, occurrence);
      if (p) return p;
    }
    throw notFound(this.closest(quote, 3));
  }

  /** findSquashed is find on squashed words; undefined when the quote is not in the text at all. */
  private findSquashed(quote: string, prefix: string, suffix: string, occurrence: number): Place | undefined {
    const all: number[] = [];
    const fit: number[] = [];
    for (let from = 0; ;) {
      const at = this.norm.indexOf(quote, from);
      if (at < 0) break;
      all.push(at);
      if (this.fits(at, quote.length, prefix, suffix)) fit.push(at);
      from = at + (this.norm.codePointAt(at)! > 0xffff ? 2 : 1);
    }
    if (all.length === 0) return undefined;
    if (fit.length === 0) throw this.ambiguous(all, quote.length, true);
    if (occurrence > 0) {
      if (occurrence > fit.length) throw new QuoteError("quote_ambiguous", "The words are not on the page that many times. Call again without occurrence to see the places they are.");
      return this.place(fit[occurrence - 1], quote.length);
    }
    if (fit.length > 1) throw this.ambiguous(fit, quote.length, false);
    return this.place(fit[0], quote.length);
  }

  private fits(at: number, n: number, prefix: string, suffix: string): boolean {
    return this.norm.slice(0, at).replace(/ +$/, "").endsWith(prefix) && this.norm.slice(at + n).replace(/^ +/, "").startsWith(suffix);
  }

  /** place is the anchor for the squashed quote at units [at, at+n) of norm. */
  private place(at: number, n: number): Place {
    let last = at + n - 1;
    const c = this.norm.charCodeAt(last);
    if (c >= 0xdc00 && c <= 0xdfff && last > at) last--;
    const start = this.at[at];
    const end = this.end[last];
    return {
      anchor: { quote: this.slice(start, end), prefix: this.slice(start - CONTEXT, start), suffix: this.slice(end, end + CONTEXT), start },
      heading: this.headingAt(start),
    };
  }

  private ambiguous(at: number[], n: number, noneFit: boolean): QuoteError {
    let s = noneFit ? "The prefix and suffix fit none of the places these words are. " : "";
    s += `These words are on the page in ${at.length} places. Call again with occurrence set to the place's number, or with prefix or suffix, a few words just before or after them:`;
    at.slice(0, MAX_LISTED).forEach((a, i) => {
      const h = this.headingAt(this.at[a]);
      s += `\n${i + 1}. ${h ? `Under "${h}": ` : "Above the first heading: "}"${this.around(a, n, 40)}"`;
    });
    if (at.length > MAX_LISTED) s += `\n(${at.length - MAX_LISTED} more further down.)`;
    return new QuoteError("quote_ambiguous", s);
  }

  /** around is the squashed text at [at, at+n) of norm with about k characters either side, an ellipsis where it cuts. */
  private around(at: number, n: number, k: number): string {
    let from = at, to = at + n;
    const isLow = (i: number) => { const c = this.norm.charCodeAt(i); return c >= 0xdc00 && c <= 0xdfff; };
    for (let i = 0; i < k && from > 0; i++) from -= from > 1 && isLow(from - 1) ? 2 : 1;
    for (let i = 0; i < k && to < this.norm.length; i++) to += this.norm.codePointAt(to)! > 0xffff ? 2 : 1;
    let s = this.norm.slice(from, to).trim();
    if (from > 0) s = "…" + s;
    if (to < this.norm.length) s += "…";
    return s;
  }

  /** closest is up to k passages of the page as long as quote, in words, that share the most words with it, best first, none overlapping, each sharing at least a third of its words. */
  private closest(quote: string, k: number): { heading: string; text: string }[] {
    const qw = words(quote).slice(0, 40);
    const want = new Map<string, number>();
    for (const w of qw) want.set(w.key, (want.get(w.key) ?? 0) + 1);
    const pw = words(this.norm);
    if (qw.length === 0 || pw.length === 0) return [];
    const n = Math.min(qw.length, pw.length);
    const have = new Map<string, number>();
    let score = 0;
    const add = (key: string, d: number) => {
      const w = want.get(key) ?? 0;
      const before = Math.min(have.get(key) ?? 0, w);
      have.set(key, (have.get(key) ?? 0) + d);
      score += Math.min(have.get(key)!, w) - before;
    };
    const ws: { start: number; score: number }[] = [];
    pw.forEach((w, i) => {
      add(w.key, 1);
      if (i >= n) add(pw[i - n].key, -1);
      if (i >= n - 1 && score > 0) ws.push({ start: i - n + 1, score });
    });
    ws.sort((a, b) => b.score - a.score);
    const floor = Math.max(1, Math.floor((qw.length + 2) / 3));
    const out: { heading: string; text: string }[] = [];
    const taken: [number, number][] = [];
    for (const w of ws) {
      if (out.length === k || w.score < floor) break;
      const s = w.start, e = w.start + n;
      if (taken.some(([x0, x1]) => s < x1 && x0 < e)) continue;
      taken.push([s, e]);
      const from = pw[s].from, to = pw[e - 1].to;
      let text = this.norm.slice(from, to);
      const chars = [...text];
      if (chars.length > 160) text = chars.slice(0, 160).join("") + "…";
      out.push({ heading: this.headingAt(this.at[from]), text });
    }
    return out;
  }

  /**
   * locate re-attaches a stored anchor as the viewer does: where it was if
   * the words are still there, else the copy of the words whose surroundings
   * match best. found is false when the words are gone, which makes a
   * comment outdated; heading is where it landed.
   */
  locate(a: Anchor): { found: boolean; heading: string } {
    if (!a.quote) return { found: false, heading: "" };
    const qu = a.quote.length;
    if (a.start >= 0 && a.start + qu <= this.raw.length && this.slice(a.start, a.start + qu) === a.quote) {
      return { found: true, heading: this.headingAt(a.start) };
    }
    let best = -1, bestScore = -1;
    for (let from = 0, n = 0; n < LOCATE_CANDIDATES; n++) {
      const at = this.raw.indexOf(a.quote, from);
      if (at < 0) break;
      const score = (commonEnd(this.slice(at - CONTEXT, at), a.prefix) + commonStart(this.slice(at + qu, at + qu + CONTEXT), a.suffix)) * 10000 -
        Math.abs(at - a.start) / 1000;
      if (score > bestScore) {
        best = at;
        bestScore = score;
      }
      from = at + (this.raw.codePointAt(at)! > 0xffff ? 2 : 1);
    }
    return best < 0 ? { found: false, heading: "" } : { found: true, heading: this.headingAt(best) };
  }
}

function notFound(closest: { heading: string; text: string }[]): QuoteError {
  let s = "These words are not on the page as it reads now. Quote the page's own words, as fmrl_get shows them.";
  if (closest.length > 0) {
    s += " The passages most like them:";
    for (const p of closest) s += `\n- ${p.heading ? `Under "${p.heading}": ` : ""}"${p.text}"`;
  }
  return new QuoteError("quote_not_found", s);
}

/** markdownText is s rendered as Markdown and indexed as a page is, squashed: "**bold** `code`" is "bold code". */
function markdownText(s: string): string {
  if (s.trim() === "") return "";
  try {
    return squash(PageText.fromHTML("<!DOCTYPE html><html><body>" + toHTML(s) + "</body></html>").raw);
  } catch {
    return "";
  }
}

interface Word { from: number; to: number; key: string }

function words(s: string): Word[] {
  const out: Word[] = [];
  const trim = /^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu;
  let start = -1;
  const flush = (end: number) => {
    if (start < 0) return;
    const key = s.slice(start, end).replace(trim, "").toLowerCase();
    if (key !== "") out.push({ from: start, to: end, key });
    start = -1;
  };
  for (let i = 0; i < s.length; i++) {
    if (s[i] === " ") flush(i);
    else if (start < 0) start = i;
  }
  flush(s.length);
  return out;
}

function commonEnd(x: string, y: string): number {
  const a = [...x], b = [...y];
  let n = 0;
  while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) n++;
  return n;
}

function commonStart(x: string, y: string): number {
  const a = [...x], b = [...y];
  let n = 0;
  while (n < a.length && n < b.length && a[n] === b[n]) n++;
  return n;
}

// ---------------------------------------------------------- whether comments show

// A script runs only when its type is empty, a JavaScript MIME type, module,
// importmap or speculationrules; any other type is a data block the browser
// never runs, like a private Markdown page's source block. A type with
// parameters counts as code, to err on the side of off.
const CODE_TYPES = new Set(["", "module", "importmap", "speculationrules", "application/ecmascript", "application/javascript",
  "application/x-ecmascript", "application/x-javascript", "text/ecmascript", "text/javascript", "text/javascript1.0",
  "text/javascript1.1", "text/javascript1.2", "text/javascript1.3", "text/javascript1.4", "text/javascript1.5", "text/jscript",
  "text/livescript", "text/x-ecmascript", "text/x-javascript"]);
const EMBEDS = new Set(["iframe", "frame", "frameset", "object", "embed", "applet", "portal", "fencedframe"]);

function textOf(n: ParentNode): string {
  let s = "";
  for (const c of n.childNodes) {
    if (c.nodeName === "#text") s += (c as DefaultTreeAdapterMap["textNode"]).value;
    else if (isElement(c)) s += textOf(c);
  }
  return s;
}

function runsOwnCode(n: ParentNode, own: readonly string[]): boolean {
  for (const c of n.childNodes) {
    if (!isElement(c)) continue;
    if (EMBEDS.has(c.tagName)) return true;
    if (c.tagName === "script") {
      const type = (c.attrs.find((a) => a.name === "type")?.value ?? "").trim().toLowerCase();
      const runs = CODE_TYPES.has(type) || type.includes(";");
      if (runs && (c.attrs.some((a) => a.name === "src") || !own.includes(textOf(c)))) return true;
    }
    for (const a of c.attrs) {
      if (/^on/i.test(a.name)) return true;
      if (/^javascript:/i.test(a.value.replace(/[\u0000- ]/g, ""))) return true;
    }
    if (c.tagName === "template" && runsOwnCode((c as DefaultTreeAdapterMap["template"]).content, own)) return true;
    if (runsOwnCode(c, own)) return true;
  }
  return false;
}

/**
 * commentsShow is whether the viewer shows comments on a private page with
 * this HTML. It doesn't on a page that could run code of its own (a script
 * that isn't fmrl's own, an inline handler, a javascript: link, or an
 * embedded document), since that code would share the frame with the
 * comments, nor on one that opens with an HTML comment. own is the exact text
 * of the scripts fmrl's own pages carry.
 */
export function commentsShow(html: string, own: readonly string[]): boolean {
  if (/^\s*<!--/.test(html)) return false;
  try {
    return !runsOwnCode(parse(html), own);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------- sealing

const SEALED_PREFIX = "s1.";
const subtle = globalThis.crypto.subtle;

async function noteKey(pageKey: string, usage: KeyUsage): Promise<CryptoKey> {
  return subtle.importKey("raw", new Uint8Array(Buffer.from(pageKey, "base64url")), "AES-GCM", false, [usage]);
}

function additionalData(pageId: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode("fmrl-annotation:" + pageId) as Uint8Array<ArrayBuffer>;
}

/** sealNote seals a comment's JSON under the page's key as the viewer does: "s1." and base64url of the nonce, ciphertext and tag, with "fmrl-annotation:" and the page id as additional data. */
export async function sealNote(pageKey: string, pageId: string, note: unknown): Promise<string> {
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await subtle.encrypt({ name: "AES-GCM", iv, additionalData: additionalData(pageId) }, await noteKey(pageKey, "encrypt"),
    new TextEncoder().encode(JSON.stringify(note))));
  const all = new Uint8Array(iv.length + ct.length);
  all.set(iv);
  all.set(ct, iv.length);
  return SEALED_PREFIX + Buffer.from(all).toString("base64url");
}

/** openNote opens a sealed comment; it rejects for the wrong key, a note sealed for another page, or one that isn't sealed. */
export async function openNote(pageKey: string, pageId: string, payload: string): Promise<unknown> {
  if (!payload.startsWith(SEALED_PREFIX)) throw new Error("not a sealed note");
  const all = new Uint8Array(Buffer.from(payload.slice(SEALED_PREFIX.length), "base64url"));
  if (all.length <= 28) throw new Error("not a sealed note");
  const plain = await subtle.decrypt({ name: "AES-GCM", iv: all.subarray(0, 12), additionalData: additionalData(pageId) }, await noteKey(pageKey, "decrypt"), all.subarray(12));
  return JSON.parse(new TextDecoder().decode(plain));
}

/** NoteData is what a comment's sealed JSON holds that this side reads: an anchor for a thread on the page's words, and its words. */
export interface NoteData { anchor?: Anchor; body: string }

/** noteData reads an opened note as the viewer does: a body that isn't text is empty, and an anchor without words is none. */
export function noteData(v: unknown): NoteData {
  const o = v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  const body = typeof o.body === "string" ? o.body : "";
  const a = o.anchor && typeof o.anchor === "object" ? (o.anchor as Record<string, unknown>) : undefined;
  if (!a || typeof a.quote !== "string" || a.quote === "") return { body };
  return {
    body,
    anchor: {
      quote: a.quote,
      prefix: typeof a.prefix === "string" ? a.prefix : "",
      suffix: typeof a.suffix === "string" ? a.suffix : "",
      start: typeof a.start === "number" ? a.start | 0 : -1,
    },
  };
}
