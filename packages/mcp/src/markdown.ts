import { marked } from "marked";

// Mirrors render.markdownCSS in the server's internal/render/document.go and
// MARKDOWN_CSS in static/fmrl.js. Drift is cosmetic; keep all three the same.
const MARKDOWN_CSS = ':root{color-scheme:light dark}' +
  'body{margin:0;padding:2rem 1.25rem;max-width:72ch;margin-inline:auto;font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;color:#1a1a1a;background:#fff}' +
  '@media (prefers-color-scheme:dark){body{color:#e6e6e6;background:#111}}' +
  'h1,h2,h3{line-height:1.25}' +
  'pre{overflow:auto;padding:1rem;background:rgba(127,127,127,.12);border-radius:6px}' +
  'code{font:.92em ui-monospace,SFMono-Regular,Menlo,monospace}' +
  'img{max-width:100%}' +
  'table{border-collapse:collapse}' +
  'td,th{border:1px solid rgba(127,127,127,.4);padding:.35rem .6rem}' +
  'blockquote{margin:0;padding-left:1rem;border-left:3px solid rgba(127,127,127,.5);color:inherit;opacity:.85}' +
  'a{color:#0b63c4}';

/**
 * looksLikeHTML is the server's share.DetectFormat: trim whitespace, strip a
 * leading U+FEFF byte-order mark, trim again, then test "<" followed by a
 * letter, "!", "/" or "?".
 */
export function looksLikeHTML(text: string): boolean {
  return /^<[A-Za-z!/?]/.test(text.trim().replace(/^﻿/, "").trim());
}

function escapeHTML(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** toHTML renders GitHub Flavored Markdown to an HTML fragment. */
export function toHTML(markdown: string): string {
  return marked.parse(markdown, { gfm: true, async: false }) as string;
}

/**
 * codePointToChar bounds a parsed numeric character reference before handing
 * it to String.fromCodePoint, which throws RangeError for anything outside
 * 0..0x10FFFF (and for lone surrogates, which are unpaired code points, not
 * valid characters). Marked's escape() does not re-escape a "&" that already
 * looks like an entity, so untrusted Markdown can carry an out-of-range
 * reference like "&#99999999;" straight through toHTML into firstHeading.
 * Out-of-range or malformed values become U+FFFD, the standard replacement
 * character, instead of throwing.
 */
function codePointToChar(n: number): string {
  if (Number.isNaN(n) || n > 0x10ffff || (n >= 0xd800 && n <= 0xdfff)) {
    return "�";
  }
  return String.fromCodePoint(n);
}

/**
 * decodeEntities reverses the handful of named entities marked ever emits in
 * escaped text (amp, lt, gt, quot), plus numeric &#NNN;/&#xHH; forms, in a
 * single pass. This is the same job static/fmrl.js does with a scratch
 * <textarea> (a DOM API Node doesn't have) so that wrapDocument's own
 * escapeHTML is the only escaping applied to the title. A single pass is
 * what a textarea does too: "&amp;lt;" decodes to "&lt;", not "<", because
 * the "lt;" left behind by decoding "&amp;" is never looked at again.
 */
function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|lt|gt|quot|amp|#39);/gi, (_, body: string) => {
    if (body[0] === "#") {
      const n = body[1]?.toLowerCase() === "x" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return codePointToChar(n);
    }
    switch (body.toLowerCase()) {
      case "lt": return "<";
      case "gt": return ">";
      case "quot": return '"';
      case "amp": return "&";
      default: return `&${body};`;
    }
  });
}

/** firstHeading is the text of the first h1..h6 in an HTML fragment, tags stripped, entities decoded, or "". */
export function firstHeading(html: string): string {
  const m = /<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/i.exec(html);
  return m ? decodeEntities(m[1].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim()) : "";
}

/** documentTitle is the browser's pageTitle (static/fmrl.js): the <title> text, tags stripped, whitespace collapsed and entities decoded, else the first heading, else "". It names a private HTML page in its sealed record. */
export function documentTitle(html: string): string {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const t = m ? decodeEntities(m[1].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim()) : "";
  return t || firstHeading(html);
}

/** wrapDocument is render.WrapDocument: a complete document with the Markdown stylesheet inlined. */
export function wrapDocument(body: string, title: string): string {
  return '<!DOCTYPE html>\n<html>\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n<title>' +
    escapeHTML(title || "Document") + "</title>\n<style>" + MARKDOWN_CSS + "</style>\n</head>\n<body>\n" + body + "\n</body>\n</html>\n";
}

const SOURCE_BLOCK = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;

/**
 * readSource is static/fmrl.js's readSource: the source a private page was
 * rendered from, when its sealed document carries one as
 * <script type="text/x-fmrl-source" data-format="…">. The browser writes the
 * text with "&" as &amp; and then "<" as &lt;, so no source can close the
 * block; this undoes exactly that, &lt; first, and nothing else. A block with
 * no data-format is Markdown, as the edit page reads it; one in a format
 * other than md or html, or no block at all, is undefined.
 */
export function readSource(html: string): { format: "md" | "html"; source: string } | undefined {
  for (const m of html.matchAll(SOURCE_BLOCK)) {
    const attrs = m[1];
    if (!/\btype\s*=\s*["']?text\/x-fmrl-source["']?(?=[\s>]|$)/i.test(attrs)) continue;
    const format = /\bdata-format\s*=\s*["']?([^"'\s>]*)/i.exec(attrs)?.[1] || "md";
    if (format !== "md" && format !== "html") return undefined;
    return { format, source: m[2].replace(/&lt;/g, "<").replace(/&amp;/g, "&") };
  }
  return undefined;
}
