import { looksLikeHTML, toHTML } from "./markdown.js";

/**
 * secretKinds names the kinds of credential that content plainly carries:
 * key material and tokens with a recognisable shape, not words like
 * "password" or a path like ~/.ssh, which docs mention all the time. A
 * public page with any of these is refused (publicRefusal); a private page
 * is the user's own business and is never scanned.
 *
 * The patterns are kept narrow on purpose: a false refusal costs a user a
 * public page they meant to share, so each one matches a token's real
 * prefix and length, not anything that merely looks random, and a match that
 * reads as a placeholder (ends in EXAMPLE, spells out a stand-in word like
 * "your" or "here", or is one character repeated) is let through, as docs and tutorials are full of those. It is a
 * backstop for common kinds, not a promise that nothing secret goes out. HTML is scanned as written and as its text
 * reads. The patterns and rules match markymd's internal/scan/secrets.go, which checks every public save again.
 */
const PATTERNS: Array<{ kind: string; re: RegExp }> = [
  { kind: "a private key block", re: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/ },
  { kind: "an AWS access key", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { kind: "a GitHub token", re: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{60,})\b/ },
  { kind: "a Slack token", re: /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/ },
  { kind: "an Anthropic API key", re: /\bsk-ant-[A-Za-z0-9_-]{20,}/ },
  // Not after a "-", "." or word character, so CSS classes and kebab-case names that contain "sk-" are not keys.
  { kind: "an OpenAI API key", re: /(?<![\w.-])sk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{32,}/ },
  { kind: "a Google API key", re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { kind: "a Stripe secret key", re: /\b(?:sk|rk)_live_[0-9A-Za-z]{20,}\b/ },
  { kind: "a GitLab token", re: /\bglpat-[A-Za-z0-9_-]{20,}/ },
  { kind: "an npm token", re: /\bnpm_[A-Za-z0-9]{36}\b/ },
  { kind: "a Hugging Face token", re: /\bhf_[A-Za-z0-9]{34,}\b/ },
  { kind: "an fmrl key", re: /\bfmrl_[A-Za-z0-9]{24,}\b/ },
];

const PREFIX = /^(?:sk-ant-|sk-(?:proj-|svcacct-|admin-)?|(?:sk|rk)_live_|gh[pousr]_|github_pat_|xox[abposr]-|AKIA|ASIA|AIza|glpat-|npm_|hf_|fmrl_)/;
const PLACEHOLDER_WORD = /^(?:your|here|placeholder|redacted|example|dummy|sample|changeme|replace|insert)$/i;

/**
 * placeholder is true for a match that is a documentation stand-in, not a key: AKIAIOSFODNN7EXAMPLE, sk-proj-xxxx…,
 * ghp_000…. A stand-in is one character over and over, or spells out that it is one; a real token can be all letters
 * (about one AWS key id in thirty is), so a missing digit proves nothing. Mirrors markymd's scan.placeholderToken.
 */
function placeholder(match: string): boolean {
  if (/EXAMPLE$/i.test(match)) return true;
  if (match.startsWith("-----BEGIN")) return false;
  const body = match.replace(PREFIX, "");
  if (new Set(body.replace(/[-_]/g, "")).size <= 2) return true;
  // A stand-in names a stand-in word as a word of its own, and readable words (three letters or more) make up at
  // least half of it. A real key's random run can hold one by chance (Q7RZ3dummyK9…, …MXKHERE5T…), but not mostly words.
  let named = false, wordy = 0, total = 0;
  for (const w of tokenWords(body)) {
    total += w.length;
    if (PLACEHOLDER_WORD.test(w)) named = true;
    if (w.length >= 3 && !/^[0-9]/.test(w)) wordy += w.length;
  }
  return named && 2 * wordy >= total;
}

/** tokenWords splits a token's body into the runs a person reads in it: at "-" and "_", between letters and digits, and where a lowercase letter meets a capital (yourKeyHere is your, Key, Here). */
export function tokenWords(body: string): string[] {
  const kind = (c: string | undefined): number => (c === undefined ? 0 : /[a-z]/.test(c) ? 1 : /[A-Z]/.test(c) ? 2 : /[0-9]/.test(c) ? 3 : 0);
  const words: string[] = [];
  let start = -1;
  for (let i = 0; i <= body.length; i++) {
    const k = kind(body[i]);
    if (start >= 0) {
      const prev = kind(body[i - 1]);
      if (k === 0 || (k === 3) !== (prev === 3) || (prev === 1 && k === 2)) {
        words.push(body.slice(start, i));
        start = -1;
      }
    }
    if (start < 0 && k !== 0) start = i;
  }
  return words;
}

/** NAMED is the named references a key's characters can hide behind: the basics, and every HTML5 name for ASCII punctuation (names are case-sensitive, as browsers read them). */
const NAMED: Record<string, string> = {
  amp: "&", AMP: "&", lt: "<", LT: "<", gt: ">", GT: ">", quot: '"', QUOT: '"', apos: "'", nbsp: "\u00a0", Tab: "\t", NewLine: "\n",
  lowbar: "_", UnderBar: "_", period: ".", sol: "/", bsol: "\\", plus: "+", equals: "=", colon: ":", semi: ";", comma: ",",
  num: "#", excl: "!", quest: "?", commat: "@", dollar: "$", percnt: "%", ast: "*", midast: "*", Hat: "^", grave: "`", DiacriticalGrave: "`",
  verbar: "|", vert: "|", VerticalLine: "|", lpar: "(", rpar: ")", lsqb: "[", rsqb: "]", lbrack: "[", rbrack: "]",
  lcub: "{", rcub: "}", lbrace: "{", rbrace: "}",
};

/** joinedText is HTML's text as a browser joins it: comments and tags removed and entities decoded, so a key that markup splits (a syntax highlighter's spans, ghp&#95;…) is found as the reader sees it. */
function joinedText(content: string): string {
  return content
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<[^>]*>/g, "")
    // A numeric reference needs no closing semicolon in a browser (ghp&#95abc reads ghp_abc); a named one is read with it.
    .replace(/&(?:#(\d+);?|#[xX]([0-9a-fA-F]+);?|([a-zA-Z]+);)/g, (all, dec?: string, hex?: string, name?: string) => {
      if (name !== undefined) return NAMED[name] ?? all;
      const n = dec !== undefined ? Number(dec) : parseInt(hex!, 16);
      return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : all;
    });
}

export function secretKinds(content: string): string[] {
  const texts = [content];
  const joined = joinedText(content);
  if (joined !== content) texts.push(joined);
  const kinds: string[] = [];
  for (const { kind, re } of PATTERNS) {
    const global = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
    found: for (const text of texts) {
      for (const m of text.matchAll(global)) {
        if (kind === "an OpenAI API key") {
          // An Anthropic key is OpenAI-shaped too: it is named once, as the Anthropic one, and an OpenAI key beside it is still found.
          if (m[0].startsWith("sk-ant-")) continue;
          // A real OpenAI key mixes cases; an all-lowercase kebab-case name that starts with "sk-" is not one.
          if (!/[A-Z]/.test(m[0])) continue;
        }
        if (!placeholder(m[0])) { kinds.push(kind); break found; }
      }
    }
  }
  return kinds;
}

/**
 * publicRefusal is the message for public content that carries secrets, or undefined when it carries none. Nothing is
 * sent either way: the scan runs here. Markdown (format "md", or no format and content that doesn't look like HTML, as
 * the server detects it) is scanned as written and as it renders, as the server does, so emphasis can't split a key
 * (gh**p**_…) past the check.
 */
export function publicRefusal(content: string, verb: "publish" | "save", title?: string, format?: "html" | "md"): string | undefined {
  let text = title ? `${title}\n${content}` : content;
  if (format === "md" || (format === undefined && !looksLikeHTML(content))) {
    try { text += `\n${toHTML(content)}`; } catch { /* the source alone is still scanned */ }
  }
  const kinds = secretKinds(text);
  if (kinds.length === 0) return undefined;
  const list = kinds.length === 1 ? kinds[0] : `${kinds.slice(0, -1).join(", ")} and ${kinds.at(-1)}`;
  return `Nothing was sent: this content looks like it contains ${list}, and a public page can be read by anyone with the link. Take the secret out, or ${verb === "publish" ? "publish it private (pass visibility: \"private\")" : "keep it off this public page"}. Tell the person what you found; don't repeat the secret itself.`;
}
