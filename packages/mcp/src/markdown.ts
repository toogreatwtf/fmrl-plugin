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
 * decodeEntities reverses the handful of named entities marked ever emits in
 * escaped text (amp, lt, gt, quot, #39), plus numeric &#NNN;/&#xHH; forms.
 * This is the same job static/fmrl.js does with a scratch <textarea> (a DOM
 * API Node doesn't have) so that wrapDocument's own escapeHTML is the only
 * escaping applied to the title. &amp; is decoded last so "&amp;lt;" becomes
 * "&lt;", not "<" — the same single-pass semantics the textarea gives.
 */
function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

/** firstHeading is the text of the first h1..h6 in an HTML fragment, tags stripped, entities decoded, or "". */
export function firstHeading(html: string): string {
  const m = /<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/i.exec(html);
  return m ? decodeEntities(m[1].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim()) : "";
}

/** wrapDocument is render.WrapDocument: a complete document with the Markdown stylesheet inlined. */
export function wrapDocument(body: string, title: string): string {
  return '<!DOCTYPE html>\n<html>\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n<title>' +
    escapeHTML(title || "Document") + "</title>\n<style>" + MARKDOWN_CSS + "</style>\n</head>\n<body>\n" + body + "\n</body>\n</html>\n";
}
