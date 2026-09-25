import { Marked, type Tokens } from "marked";
import { PROFILE_TYPE, decodeEntities } from "./markdown.js";

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

const plain = (html: string) => decodeEntities(html.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim());

function fromMarkdown(content: string): Found | undefined {
  const tokens = md.lexer(content);
  const block = tokens.find((t): t is Tokens.Code => t.type === "code" && /^\S*/.exec((t as Tokens.Code).lang ?? "")?.[0] === "fmrl-profile");
  if (!block) return undefined;
  const headings = tokens
    .filter((t): t is Tokens.Heading => t.type === "heading")
    .map((t, i) => ({ text: plain(md.parseInline(t.text) as string), start: i }));
  return { body: block.text, headings, marks: [] };
}

const SCRIPT = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
const TYPE_ATTR = /(?:^|\s)type\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i;
const HEADING = /<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1\s*>/gi;
const MARK = /<[A-Za-z][^>]*?\sdata-fmrl-section\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))[^>]*>/g;

function fromHTML(content: string): Found | undefined {
  let body: string | undefined;
  for (const m of content.matchAll(SCRIPT)) {
    const t = TYPE_ATTR.exec(m[1]);
    if (t && (t[1] ?? t[2] ?? t[3]) === PROFILE_TYPE) { body = m[2]; break; }
  }
  if (body === undefined) return undefined;
  const headings = [...content.matchAll(HEADING)].map((m) => ({ text: plain(m[2]), start: m.index! }));
  const marks = [...content.matchAll(MARK)].map((m) => ({ id: m[1] ?? m[2] ?? m[3], at: m.index! }));
  return { body, headings, marks };
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
  for (const [i, s] of o.sections.entries()) {
    if (typeof s !== "object" || s === null || Array.isArray(s)) return not(`section ${i + 1} is not an object`);
    const r = s as Record<string, unknown>;
    if (typeof r.id !== "string" || r.id === "") return not(`section ${i + 1} has no id`);
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
  const claimed = new Set<number>();
  const section_map: SectionMap = {};
  const claim = (id: string, i: number) => {
    claimed.add(i);
    section_map[id] = { heading: found.headings[i].text, position: i + 1 };
  };
  for (const { id, at } of found.marks) {
    if (!ids.has(id) || id in section_map) continue;
    const i = found.headings.findIndex((h) => h.start >= at);
    if (i >= 0 && !claimed.has(i)) claim(id, i);
  }
  const slugs = found.headings.map((h) => slug(h.text));
  for (const match of [(s: string, id: string) => s === id, (s: string, id: string) => s.startsWith(id + "-")]) {
    for (const { id } of profile.sections) {
      if (id in section_map) continue;
      const i = slugs.findIndex((s, j) => !claimed.has(j) && match(s, id));
      if (i >= 0) claim(id, i);
    }
  }
  const missing = profile.sections.map((s) => s.id).filter((id) => !(id in section_map));
  return { profile, section_map, missing };
}
