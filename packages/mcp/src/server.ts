import { open as fsOpen, stat as fsStat } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ApiError, type DocResponse, type Editor, type FmrlApi, type InboxItem, type MeResponse, type PublishRequest, type PublishResponse, type UpdateResponse } from "./api.js";
import { openRecord, seal, sealRecord, sealWithKey, type OpenedRecord } from "./crypto.js";
import { MAX_BYTES, TOO_LARGE_MESSAGE, formatForPath } from "./format.js";
import { parseDocId, parsePageRef } from "./ids.js";
import { MINT_LABEL, prefixOf, type KeyStore } from "./keys.js";
import { documentTitle, firstHeading, looksLikeHTML, readSource, toHTML, wrapDocument } from "./markdown.js";
import { openPrivatePage } from "./opener.js";
import type { PageStore } from "./pages.js";
import { pluginInstructions, pluginLine, pluginStatus } from "./plugin.js";

// The version the server reports to MCP clients is the package's, read at
// runtime, so a release bump in package.json cannot leave this behind.
export const { version: VERSION } = createRequire(import.meta.url)("../package.json") as { version: string };

export interface ServerDeps {
  api: FmrlApi;
  keys: KeyStore;
  /** pages holds the content keys and manage tokens of pages this machine has opened. */
  pages: PageStore;
  open?: typeof fsOpen;
  stat?: typeof fsStat;
  log?: (line: string) => void;
  /** agentName is FMRL_AGENT_NAME: the name this key's revisions carry, replacing any other. Without it, the MCP client's own name fills an empty one. */
  agentName?: string;
  /** pluginRoot is CLAUDE_PLUGIN_ROOT: set when the Claude Code plugin launched this server. */
  pluginRoot?: string;
}

export const SEVEN_DAYS = "This page lasts seven days unless someone keeps it on the page itself.";

type ToolResult = { content: Array<{ type: "text"; text: string }>; structuredContent?: Record<string, unknown>; isError?: boolean };

function ok(text: string, structured: Record<string, unknown>): ToolResult {
  return { content: [{ type: "text", text }], structuredContent: structured };
}
function fail(message: string): ToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}
function errorText(e: unknown): string {
  if (e instanceof ApiError) {
    let msg = e.resetsAt && !e.message.includes(e.resetsAt) ? `${e.message} Resets at ${e.resetsAt}.` : e.message;
    if (e.status === 429 && e.retryAfterSeconds) {
      msg += e.retryAfterSeconds < 120
        ? ` Try again in ${e.retryAfterSeconds} seconds.`
        : ` Try again in ${Math.ceil(e.retryAfterSeconds / 60)} minutes.`;
    }
    return msg;
  }
  return e instanceof Error ? e.message : String(e);
}

// Said only of a link that carries the ring: when the ring couldn't be saved,
// the link goes out without #r= and the browser it links can't open private pages.
const ringCarried = (url: string) => (/[#&]r=/.test(url) ? " It also carries the ring that lets that browser open your private pages." : "");

export const LINK_HINT = (url: string) => `See your pages on fmrl.site: open ${url} once in your browser (it works for an hour, and once).${ringCarried(url)}`;

/** withRing appends key's ring to a browser link as #r=<prefix>.<ring>. The link page stores it for the key its form names; the server never sees a fragment. */
export function withRing(linkUrl: string, key: string, ring: string): string {
  return `${linkUrl}${linkUrl.includes("#") ? "&" : "#"}r=${prefixOf(key)}.${ring}`;
}
export const RING_FILE_LINE = (file: string) => `Your key ring is in ${file}; back up that file to keep every page's key.`;
export const RING_ENV_LINE = "Your key ring comes from FMRL_RING; back up that value to keep every page's key.";
const RING_UNSAVED_LINE = (file: string, why: string) => `Couldn't save a key ring to ${file} (${why}); private pages publish without their key sealed until it can be written, or FMRL_RING is set.`;

function publishTextLines(p: PublishResponse, expiryLine: string): string[] {
  const lines = [
    `Published: ${p.url}`,
    `Expires ${p.expires_at}`,
    expiryLine,
    `Manage link (removes the page; give it only to someone who should be able to): ${p.manage_url}`,
  ];
  if (p.link_url) lines.push(LINK_HINT(p.link_url));
  return lines;
}
function publishText(p: PublishResponse): string {
  return publishTextLines(p, SEVEN_DAYS).join("\n");
}
export const SEVEN_DAYS_PRIVATE = "This page lasts seven days; a private page cannot be kept.";
export const PRIVATE_LINE = "This page is private: it was encrypted here before upload, and the key is the part of the link after #p=. fmrl.site cannot read or recover it.";

/** preparePrivate renders (if Markdown) and seals content — under pageKey when one is given (a new revision of a private page), else under a fresh key — returning the request body, the link key, and the title the sealed record carries: the title given, else the first heading for Markdown, else the document's <title> or first heading for HTML. The request body never carries a title. verb names the act in the refusal of a page that renders empty. */
async function preparePrivate(content: string, format: "html" | "md" | undefined, title: string | undefined, pageKey?: string, verb: "publish" | "save" = "publish"): Promise<{ body: { content: string; format: "html"; encrypted: true }; key: string; title: string }> {
  let html = content;
  let name: string;
  if (format === "md" || (format === undefined && !looksLikeHTML(content))) {
    const body = toHTML(content);
    if (body.trim() === "") {
      throw new Error(`Nothing to ${verb}: the content rendered to an empty page.`);
    }
    name = title || firstHeading(body);
    html = wrapDocument(body, name);
  } else {
    name = title || documentTitle(content);
  }
  const sealed = pageKey ? { envelope: await sealWithKey(html, pageKey), key: pageKey } : await seal(html);
  const envBytes = Buffer.byteLength(sealed.envelope, "utf8");
  if (envBytes > MAX_BYTES) {
    throw new Error(`The encrypted page is ${envBytes} bytes, over the 2 MiB limit. Encryption adds about a third, so roughly 1.4 MB of HTML fits.`);
  }
  return { body: { content: sealed.envelope, format: "html", encrypted: true }, key: sealed.key, title: name };
}

function withFragment(p: PublishResponse, key: string): PublishResponse {
  return { ...p, url: `${p.url}#p=${key}` };
}
function privateText(p: PublishResponse): string {
  return [...publishTextLines(p, SEVEN_DAYS_PRIVATE), PRIVATE_LINE].join("\n");
}

/** unseal opens a sealed record with the first ring that fits, or answers undefined: a page whose key this machine does not hold. */
async function unseal(rings: string[], sealed: string | undefined): Promise<OpenedRecord | undefined> {
  if (!sealed) return undefined;
  for (const ring of rings) {
    try {
      return await openRecord(ring, sealed);
    } catch {
      // Not this ring.
    }
  }
  return undefined;
}

/** PageRow is a page as fmrl_get and fmrl_list hand it back: the API's description minus the sealed record. A private page whose record opened here carries its title, and its keyed link as url. */
type PageRow = {
  id: string; url: string; status: string; format: string; size: number; expires_at: string | null;
  pinned: boolean; cid?: string; private: boolean; key_held?: boolean; title?: string;
};

function pageRow(d: DocResponse, opened: OpenedRecord | undefined): PageRow {
  const row: PageRow = { id: d.id, url: d.url, status: d.status, format: d.format, size: d.size, expires_at: d.expires_at, pinned: d.pinned, private: d.private === true };
  if (d.cid) row.cid = d.cid;
  if (row.private) {
    row.key_held = opened !== undefined;
    if (opened) {
      row.url = `${d.url}#p=${opened.key}`;
      row.title = opened.title;
    }
  }
  return row;
}

export const NOT_HELD_LINE = "This page is private and its key is not held here: it opens from its link, or from a browser linked to the key that published it.";

function docText(r: PageRow): string {
  const kept = r.pinned ? `kept forever${r.cid ? ` (${r.cid})` : ""}` : `expires ${r.expires_at}`;
  const name = r.key_held && r.title ? `${r.title} — ` : "";
  const lines = [`${name}${r.url}: ${r.status}, ${r.format}, ${r.size} bytes, ${kept}.`];
  if (r.private && !r.key_held) lines.push(NOT_HELD_LINE);
  lines.push(r.private ? SEVEN_DAYS_PRIVATE : SEVEN_DAYS);
  return lines.join("\n");
}

/** PageRead is fmrl_get's answer: the page row, the revision read and who made it, and its content — or, for a private page no key here opens, a note saying how to read it. */
type PageRead = PageRow & {
  rev: number; latest_rev: number; editor: Editor;
  content?: string; content_format?: "html" | "md"; content_note?: string;
};

export const PRIVATE_NOTE = "private: pass the link with #p=<key> to read it";

function editorText(e: Editor): string {
  const key = e.key ? `${e.key}…` : undefined;
  if (e.name) return key ? `${e.name} (${key})` : e.name;
  if (key) return key;
  if (e.kind === "session") return "a linked browser";
  if (e.kind === "manage") return "a manage link";
  return "someone unknown";
}

function readText(r: PageRead, at: string): string {
  const [meta, ...rest] = docText(r).split("\n");
  return [meta, `Revision ${r.rev} of ${r.latest_rev}, edited by ${editorText(r.editor)} at ${at}.`, ...rest, "", r.content ?? r.content_note ?? ""].join("\n");
}

export const PRIVATE_NEEDS_KEY = "This page is private: pass its link with #p=<key>.";
export const MANAGE_HINT = (origin: string, id: string) => `You can edit this page with its manage link (${origin}/manage/${id}#k=…); pass it as id once and it is remembered.`;
export const CONFLICT = (rev: number) => `Revision ${rev} is the latest; read it with fmrl_get and edit from there.`;

/** EditConflict is a 409 on fmrl_edit: someone saved revision latest after the base_rev the caller read. */
class EditConflict extends Error {
  constructor(public readonly latest: number) { super(CONFLICT(latest)); }
}

type EditResult = { id: string; url: string; rev: number };

export const LIST_EMPTY = "This key has no pages right now; removed and expired pages are not listed.";

function when(r: PageRow): string {
  const life = r.pinned ? "kept" : `expires ${r.expires_at}`;
  return r.status === "live" || r.status === "pinned" ? life : `${life}, ${r.status}`;
}
function listLine(r: PageRow): string {
  if (!r.private) return `- ${r.url} — ${when(r)}`;
  if (!r.key_held) return `- private page (key not held here) — ${r.url} — ${when(r)}`;
  return `- ${r.title || "untitled private page"} — ${r.url} — ${when(r)}`;
}
function listText(rows: PageRow[]): string {
  if (rows.length === 0) return LIST_EMPTY;
  const count = rows.length === 1 ? "1 page" : `${rows.length} pages`;
  return [`${count} on this key, newest first${rows.length >= 50 ? " (the newest 50)" : ""}:`, ...rows.map(listLine)].join("\n");
}
export const UNNAMED_LINE = "Unnamed: set FMRL_AGENT_NAME to name the revisions this key makes.";
function meText(m: MeResponse, ringLine: string, plugin: string | undefined): string {
  const q = m.quota.publishes;
  const linked = m.linked_at ? `Linked to a browser on ${m.linked_at}.` : "Not linked to any browser yet.";
  const named = m.label ? `Named ${m.label}: the revisions this key makes carry that name.` : UNNAMED_LINE;
  const lines = [`${m.prefix}…: ${q.used} of ${q.limit} publishes used this month, resets ${q.resets_at}.`, named, linked];
  if (m.link_url) lines.push(`To see this key's pages on fmrl.site, open ${m.link_url} (works for an hour, and once).${ringCarried(m.link_url)}`);
  return [...lines, ringLine, ...(plugin ? [plugin] : []), SEVEN_DAYS].join("\n");
}

/** WatchRow is fmrl_watch's answer: the server's watch, the page's keyed link when a key here opens it, and whether fmrl_get can read it here. */
type WatchRow = { id: string; url: string; private: boolean; rev: number; seen_rev: number; can_open: boolean };

function watchText(w: WatchRow): string {
  const lines = [`Watching ${w.url}: revision ${w.rev}, read through ${w.seen_rev}. Revisions other editors make show up in fmrl_inbox.`];
  if (!w.can_open) lines.push(PRIVATE_NEEDS_KEY);
  return lines.join("\n");
}

/** InboxRow is one fmrl_inbox item: the server's, plus whether fmrl_get can read it here (a public page, or a private one whose key the page store holds). */
type InboxRow = InboxItem & { can_open: boolean };

export const INBOX_EMPTY = "Nothing new: no page you watch has a revision someone else made since you last read it.";

/** editorName is who made a revision, as the inbox says it: the key's name, else its prefix, else the kind of editor. */
function editorName(e: Editor): string {
  return e.name || (e.key ? `${e.key}…` : e.kind);
}
function inboxLine(it: InboxRow): string {
  const revs = it.revisions.map((r) => `rev ${r.rev} by ${editorName(r.editor)}`).join(", ");
  const readable = it.status === "live" || it.status === "pinned";
  const next = !readable
    ? `${it.status}, so it can no longer be read`
    : it.can_open ? `read with fmrl_get ${it.url} rev ${it.rev}` : `read with fmrl_get ${it.url}#p=<key> rev ${it.rev} (private; its key is not held here)`;
  return `- ${it.id} (${it.status}): ${revs} — ${next}`;
}
function inboxText(items: InboxRow[]): string {
  if (items.length === 0) return INBOX_EMPTY;
  const count = items.length === 1 ? "1 page has" : `${items.length} pages have`;
  return [`${count} revisions you haven't read, newest first:`, ...items.map(inboxLine)].join("\n");
}

const publishOutput = {
  id: z.string(), url: z.string(), raw_url: z.string(), manage_url: z.string(), expires_at: z.string(), status: z.string(),
  link_url: z.string().optional(),
};
const pageOutput = {
  id: z.string(), url: z.string(), status: z.string(), format: z.string(), size: z.number(),
  expires_at: z.string().nullable(), pinned: z.boolean(), cid: z.string().optional(),
  private: z.boolean(), key_held: z.boolean().optional(), title: z.string().optional(),
};
const readOutput = {
  ...pageOutput,
  rev: z.number(), latest_rev: z.number(),
  editor: z.object({ kind: z.string(), key: z.string().optional(), name: z.string().optional() }),
  content: z.string().optional(), content_format: z.enum(["html", "md"]).optional(), content_note: z.string().optional(),
};
const editOutput = {
  // On a conflict the tool fails with only id and latest_rev; url and rev come with every saved edit.
  id: z.string(), url: z.string().optional(), rev: z.number().optional(), latest_rev: z.number().optional(),
};
const listOutput = { docs: z.array(z.object(pageOutput)) };
const watchOutput = {
  id: z.string(), url: z.string(), private: z.boolean(), rev: z.number(), seen_rev: z.number(), can_open: z.boolean(),
};
const editorOutput = z.object({ kind: z.string(), key: z.string().optional(), name: z.string().optional() });
const inboxOutput = {
  items: z.array(z.object({
    id: z.string(), url: z.string(), private: z.boolean(), status: z.string(), rev: z.number(), seen_rev: z.number(),
    revisions: z.array(z.object({ rev: z.number(), at: z.string(), editor: editorOutput })),
    can_open: z.boolean(),
  })),
};
const meOutput = {
  prefix: z.string(), created_at: z.string(), label: z.string().optional(),
  quota: z.object({ publishes: z.object({ used: z.number(), limit: z.number(), resets_at: z.string() }) }),
  linked_at: z.string().nullable().optional(), link_url: z.string().optional(),
};

/** createServer registers the nine tools on an McpServer. deps.keys owns the key; deps.api speaks HTTP. */
export function createServer(deps: ServerDeps): McpServer {
  const { api, keys, pages } = deps;
  const open = deps.open ?? fsOpen;
  const stat = deps.stat ?? fsStat;
  // Read once at startup: a plugin update takes a restart to load anyway.
  const plugin = pluginStatus(deps.pluginRoot, VERSION);
  const instructions = pluginInstructions(plugin);
  const server = new McpServer({ name: "fmrl", version: VERSION }, instructions ? { instructions } : undefined);

  const log = deps.log;

  /** ringOrNothing is keys.ringFor for a caller that must not fail on it: a page goes out without a sealed record, and a link without a ring, rather than not at all. */
  const ringOrNothing = async (k: string): Promise<string | undefined> => {
    try {
      return await keys.ringFor(k);
    } catch (e) {
      log?.(`fmrl-mcp: couldn't save a key ring to ${keys.file}: ${errorText(e)}`);
      return undefined;
    }
  };

  /**
   * publishAs publishes body as key k. A private page (secret set) carries
   * its key and title sealed under k's ring; a link_url in the answer gets
   * #r= so the browser that redeems it holds the ring too. It runs inside
   * withKey, so a retry after a 401 seals under the replacement key's ring.
   */
  const publishAs = async (k: string, body: PublishRequest, secret?: { key: string; title: string }): Promise<PublishResponse> => {
    let ring: string | undefined;
    if (secret) {
      ring = await ringOrNothing(k);
      if (ring) body = { ...body, sealed: await sealRecord(ring, secret.key, secret.title) };
    }
    const p = await api.publish(k, body);
    if (!p.link_url) return p;
    ring ??= await ringOrNothing(k);
    return ring ? { ...p, link_url: withRing(p.link_url, k, ring) } : p;
  };

  /** remember stores what this machine may keep about a page; a store that can't be written costs a log line, never the tool call, and the line never carries the secret. */
  const remember = async (id: string, s: { key?: string; manage?: string }): Promise<void> => {
    try {
      await pages.remember(id, s);
    } catch (e) {
      log?.(`fmrl-mcp: couldn't remember page ${id}: ${errorText(e)}`);
    }
  };
  /** manageTokenOf is the #k= token of a publish's manage_url. */
  const manageTokenOf = (manageUrl: string): string | undefined => {
    try { return parsePageRef(manageUrl).manage; } catch { return undefined; }
  };

  /**
   * named holds, per key, the one attempt this process makes to name it:
   * FMRL_AGENT_NAME replaces any other name; without it the MCP client's own
   * name (from initialize) fills an empty one, or the one a minted key starts with. A failure costs one log line.
   */
  const named = new Map<string, Promise<void>>();
  const nameKey = async (k: string): Promise<void> => {
    try {
      const me = await api.me(k);
      // The name a minted key starts with counts as no name at all.
      const unnamed = !me.label || me.label === MINT_LABEL;
      const want = deps.agentName ?? (unnamed ? server.server.getClientVersion()?.name : undefined);
      if (want && want !== me.label) await api.setLabel(k, want);
    } catch (e) {
      log?.(`fmrl-mcp: couldn't name key ${prefixOf(k)}…: ${errorText(e)}`);
    }
  };
  const ensureName = (k: string): Promise<void> => {
    let p = named.get(k);
    if (!p) named.set(k, (p = nameKey(k)));
    return p;
  };
  /** withKey is keys.withKey with the key named first; naming never fails the call. */
  const withKey = <T>(fn: (key: string) => Promise<T>): Promise<T> => keys.withKey(async (k) => {
    await ensureName(k);
    return fn(k);
  });

  const run = async <T extends Record<string, unknown>>(fn: (key: string) => Promise<T>, render: (v: T) => string): Promise<ToolResult> => {
    try {
      const v = await withKey(fn);
      return ok(render(v), v);
    } catch (e) {
      return fail(errorText(e));
    }
  };

  /** publishOrSeal is the shared branch behind fmrl_publish and fmrl_publish_file: publish as given, or seal first when private was asked for. */
  const publishOrSeal = async (
    content: string, format: "html" | "md" | undefined, title: string | undefined, priv: boolean | undefined,
  ): Promise<ToolResult> => {
    // Refuse blank content before any request, on every path: the server
    // turns empty content away too, but a local message is clearer than a
    // 400, and a private page would otherwise seal and publish a blank page.
    if (content.trim() === "") {
      return fail("Nothing to publish: the content is empty.");
    }
    if (!priv) {
      return run<PublishResponse & Record<string, unknown>>(async (k) => {
        const p = await publishAs(k, { content, format, title });
        await remember(p.id, { manage: manageTokenOf(p.manage_url) });
        return p as PublishResponse & Record<string, unknown>;
      }, publishText);
    }
    let prepared: Awaited<ReturnType<typeof preparePrivate>>;
    try {
      prepared = await preparePrivate(content, format, title);
    } catch (e) {
      return fail(errorText(e));
    }
    return run<PublishResponse & Record<string, unknown>>(
      async (k) => {
        const p = await publishAs(k, prepared.body, { key: prepared.key, title: prepared.title });
        await remember(p.id, { key: prepared.key, manage: manageTokenOf(p.manage_url) });
        return withFragment(p, prepared.key) as PublishResponse & Record<string, unknown>;
      },
      privateText,
    );
  };

  server.registerTool(
    "fmrl_publish",
    {
      title: "Publish a page to fmrl.site",
      description: "Publish HTML or Markdown as a page on fmrl.site and get its link. The page lasts seven days unless someone keeps it from the page itself. Pass private: true to encrypt it here first. Only call this when the user asked to share, send, or get a link for something.",
      // Strict: an unknown argument (the passphrase of older clients, say) is
      // refused rather than dropped, so nothing meant to be private publishes in the clear.
      inputSchema: z.object({
        content: z.string().min(1).describe("The HTML or Markdown to publish (2 MiB at most)."),
        format: z.enum(["html", "md"]).optional().describe("html or md; leave out to let the server detect it."),
        title: z.string().optional().describe("Page title; the first heading is used when left out. For a private page the server stores no title; when the content is rendered from Markdown the encrypted document's own title uses it (falling back to the first heading), and raw HTML is sealed as-is."),
        private: z.boolean().optional().describe("Encrypt the page here before upload; the returned link carries the key after #p=. The page has no title or preview on fmrl.site and cannot be recovered without the link."),
      }).strict(),
      outputSchema: publishOutput,
    },
    async ({ content, format, title, private: priv }) => publishOrSeal(content, format, title, priv),
  );

  server.registerTool(
    "fmrl_publish_file",
    {
      title: "Publish a file to fmrl.site",
      description: "Publish a .html, .htm, .md, .markdown, .mdx or .txt file (2 MiB at most) as a page on fmrl.site and get its link. Pass private: true to encrypt it here first. Only call this when the user asked to share the file.",
      inputSchema: z.object({
        path: z.string().min(1).describe("Absolute path to the file (a leading ~ is expanded)."),
        title: z.string().optional().describe("Page title; the file's first heading is used when left out. For a private page the server stores no title; when the content is rendered from Markdown the encrypted document's own title uses it (falling back to the first heading), and raw HTML is sealed as-is."),
        private: z.boolean().optional().describe("Encrypt the page here before upload; the returned link carries the key after #p=. The page has no title or preview on fmrl.site and cannot be recovered without the link."),
      }).strict(),
      outputSchema: publishOutput,
    },
    async ({ path: p, title, private: priv }) => {
      let format: "html" | "md";
      let content: string;
      try {
        const expanded = p === "~" || p.startsWith("~/") ? path.join(os.homedir(), p.slice(1)) : p;
        const resolved = path.resolve(expanded);
        format = formatForPath(resolved);
        const info = await stat(resolved);
        if (info.size > MAX_BYTES) return fail(TOO_LARGE_MESSAGE);
        const buf = Buffer.alloc(MAX_BYTES + 1);
        let bytesRead: number;
        const handle = await open(resolved, "r");
        try {
          ({ bytesRead } = await handle.read(buf, 0, MAX_BYTES + 1, 0));
        } finally {
          await handle.close();
        }
        if (bytesRead > MAX_BYTES) return fail(TOO_LARGE_MESSAGE);
        try {
          content = new TextDecoder("utf-8", { fatal: true }).decode(buf.subarray(0, bytesRead));
        } catch {
          return fail("That file isn't UTF-8 text.");
        }
      } catch (e) {
        return fail(errorText(e));
      }
      return publishOrSeal(content, format, title, priv);
    },
  );

  server.registerTool(
    "fmrl_get",
    {
      title: "Read a fmrl.site page",
      description: "Read a page by id or link: its metadata and, for revision `rev` (default the latest), its content. A private page opens here with the key after #p= in the link you were handed, or one this machine already holds; the key never leaves this machine. Reading a revision of a page you watch marks it seen.",
      inputSchema: {
        id: z.string().min(1).describe("A page id or any fmrl.site link for it; a link may carry the page's key (#p=) and a manage token (#k=)."),
        rev: z.number().int().min(1).optional().describe("The revision to read; the latest when left out."),
      },
      outputSchema: readOutput,
    },
    async ({ id, rev }) => {
      let ref: ReturnType<typeof parsePageRef>;
      try { ref = parsePageRef(id); } catch (e) { return fail(errorText(e)); }
      let at = "";
      return run<PageRead>(async (k) => {
        const d = await api.get(k, ref.id);
        const latest = d.rev ?? 1;
        const r = await api.getRevision(k, ref.id, rev ?? latest);
        at = r.at;
        const read = (row: PageRow): PageRead => ({ ...row, rev: r.rev, latest_rev: latest, editor: r.editor });
        if (!d.private) return { ...read(pageRow(d, undefined)), content: r.content, content_format: r.format };
        const opened = await openPrivatePage(ref, r.content, d.sealed, { pages, rings: () => keys.ringsFor(k), log });
        if (!opened) return { ...read(pageRow(d, undefined)), content_note: PRIVATE_NOTE };
        const row = read(pageRow(d, { key: opened.key, title: opened.title ?? documentTitle(opened.html) }));
        const src = readSource(opened.html);
        return src ? { ...row, content: src.source, content_format: src.format } : { ...row, content: opened.html, content_format: "html" };
      }, (v) => readText(v, at));
    },
  );

  server.registerTool(
    "fmrl_edit",
    {
      title: "Edit a fmrl.site page",
      description: "Replace a page's content with a new revision. Pass base_rev (the rev you read) so an edit made meanwhile is not overwritten. Works on your own pages and on any page whose manage link you were given; a private page stays private under its same key, so every existing link keeps opening it.",
      inputSchema: {
        id: z.string().min(1).describe("A page id or any fmrl.site link for it; a link may carry the page's key (#p=) and a manage token (#k=), which are remembered here once they work."),
        content: z.string().min(1).describe("The page's new HTML or Markdown (2 MiB at most)."),
        format: z.enum(["html", "md"]).optional().describe("html or md; leave out to let the server detect it. A private page is always sent as HTML, rendered here from Markdown."),
        title: z.string().optional().describe("Page title; for a private page it titles the encrypted document only."),
        base_rev: z.number().int().min(1).optional().describe("The revision you read and are editing from; the edit fails if someone saved a newer one."),
      },
      outputSchema: editOutput,
    },
    async ({ id, content, format, title, base_rev }) => {
      let ref: ReturnType<typeof parsePageRef>;
      try { ref = parsePageRef(id); } catch (e) { return fail(errorText(e)); }
      if (content.trim() === "") return fail("Nothing to save: the content is empty.");
      try {
        const v = await withKey(async (k): Promise<EditResult> => {
          let stored: { key?: string; manage?: string } = {};
          try {
            stored = await pages.get(ref.id);
          } catch (e) {
            log?.(`fmrl-mcp: couldn't read the page store: ${errorText(e)}`);
          }
          const d = await api.get(k, ref.id);
          let body: Parameters<FmrlApi["update"]>[2] = { content, format, title, base_rev };
          let pageKey: string | undefined;
          if (d.private) {
            // Prove the key against base_rev (the revision the caller edits
            // from and has genuinely read), not the latest: reading marks a
            // revision seen, so a conflicting edit must not advance seen past
            // the revisions between base_rev and latest that were never read.
            const current = await api.getRevision(k, ref.id, base_rev ?? d.rev ?? 1);
            // The link's manage token is left out here: it is remembered only once an edit made with it is accepted.
            const opened = await openPrivatePage({ id: ref.id, key: ref.key }, current.content, d.sealed, { pages, rings: () => keys.ringsFor(k), log });
            if (!opened) throw new Error(PRIVATE_NEEDS_KEY);
            pageKey = opened.key;
            body = { ...(await preparePrivate(content, format, title, pageKey, "save")).body, base_rev };
          }
          // The owner key needs no token and is never given one to store. Anyone
          // else tries the link's token, then once more the stored one; a link's
          // token is remembered only after the server accepts an edit made with it.
          const owned = d.owned === true;
          const tokens: (string | undefined)[] = owned ? [undefined] : [...new Set([ref.manage, stored.manage].filter((t) => t !== undefined))];
          if (tokens.length === 0) tokens.push(undefined);
          let u: UpdateResponse | undefined;
          let used: string | undefined;
          for (const token of tokens) {
            try {
              u = await api.update(k, ref.id, body, token);
              used = token;
              break;
            } catch (e) {
              if (e instanceof ApiError && e.status === 409 && e.code === "conflict" && e.rev !== undefined) throw new EditConflict(e.rev);
              if (!(e instanceof ApiError && e.status === 404 && !owned)) throw e;
            }
          }
          if (!u) throw new Error(MANAGE_HINT(new URL(d.url).origin, ref.id));
          if (used !== undefined && used === ref.manage && used !== stored.manage) await remember(ref.id, { manage: used });
          return { id: u.id, url: pageKey ? `${u.url}#p=${pageKey}` : u.url, rev: u.rev };
        });
        return ok(`Saved revision ${v.rev} of ${v.url}`, v);
      } catch (e) {
        if (e instanceof EditConflict) return { ...fail(e.message), structuredContent: { id: ref.id, latest_rev: e.latest } };
        return fail(errorText(e));
      }
    },
  );

  server.registerTool(
    "fmrl_watch",
    {
      title: "Watch a fmrl.site page",
      description: "Watch a page so revisions other editors make show up in fmrl_inbox. Pass the link you were handed; its key stays on this machine. Pages you publish are watched already.",
      inputSchema: {
        id: z.string().min(1).describe("A page id or any fmrl.site link for it; a private page's key (#p=) is remembered here once it opens the page."),
        seen_rev: z.number().int().min(0).optional().describe("The revision you have read through; later ones show up in fmrl_inbox. Leave out to start from the latest (or keep where an existing watch is)."),
      },
      outputSchema: watchOutput,
    },
    async ({ id, seen_rev }) => {
      let ref: ReturnType<typeof parsePageRef>;
      try { ref = parsePageRef(id); } catch (e) { return fail(errorText(e)); }
      return run<WatchRow>(async (k) => {
        const d = await api.get(k, ref.id);
        let w = await api.watch(k, ref.id, seen_rev);
        let key: string | undefined;
        if (d.private) {
          // Proving the key means reading a revision, and reading one marks it
          // seen; the watch is put back where it was when that moved it.
          const current = await api.getRevision(k, ref.id, w.rev);
          key = (await openPrivatePage(ref, current.content, d.sealed, { pages, rings: () => keys.ringsFor(k), log }))?.key;
          if (w.seen_rev < w.rev) w = await api.watch(k, ref.id, w.seen_rev);
        }
        return { ...w, url: key ? `${w.url}#p=${key}` : w.url, can_open: !w.private || key !== undefined };
      }, watchText);
    },
  );

  /** keyHeld says whether the page store holds a content key for id; a store that can't be read costs a log line and reads as no. */
  const keyHeld = async (id: string): Promise<boolean> => {
    try {
      return (await pages.get(id)).key !== undefined;
    } catch (e) {
      log?.(`fmrl-mcp: couldn't read the page store: ${errorText(e)}`);
      return false;
    }
  };

  server.registerTool(
    "fmrl_inbox",
    {
      title: "Pages revised since you read them",
      description: "Pages you watch that someone else has revised since you last read them, newest first. Read each with fmrl_get (which marks it seen). A page that was removed or expired appears once.",
      inputSchema: {},
      outputSchema: inboxOutput,
    },
    async () => run<{ items: InboxRow[] }>(async (k) => {
      const { items } = await api.inbox(k);
      return { items: await Promise.all(items.map(async (it) => ({ ...it, can_open: !it.private || (await keyHeld(it.id)) }))) };
    }, (v) => inboxText(v.items)),
  );

  server.registerTool(
    "fmrl_list",
    {
      title: "List this key's fmrl.site pages",
      description: "List the pages this key owns, newest first (50 at most): published through it, or shared from a browser linked to it. A private page comes back with its title and its link with the key after #p= when this machine holds the key ring. Use it when the user asks for a page they shared earlier.",
      inputSchema: {},
      outputSchema: listOutput,
    },
    async () => run<{ docs: PageRow[] }>(async (k) => {
      const [{ docs }, rings] = await Promise.all([api.list(k), keys.ringsFor(k)]);
      return { docs: await Promise.all(docs.map(async (d) => pageRow(d, d.private ? await unseal(rings, d.sealed) : undefined))) };
    }, (v) => listText(v.docs)),
  );

  server.registerTool(
    "fmrl_delete",
    {
      title: "Remove a fmrl.site page",
      description: "Remove a page this key published, by id or URL. The page answers 410 from then on. Only call this when the user asked to remove it.",
      inputSchema: { id: z.string().min(1).describe("A document id or any fmrl.site URL for it.") },
      outputSchema: { id: z.string(), url: z.string(), removed: z.boolean() },
    },
    async ({ id }) => {
      let docId: string;
      try { docId = parseDocId(id); } catch (e) { return fail(errorText(e)); }
      const url = `${api.viewerBase}/${docId}`;
      return run(
        async (k) => { await api.delete(k, docId); return { id: docId, url, removed: true }; },
        (v) => `Removed page ${v.id}. It answers 410 from now on.\n${SEVEN_DAYS}`,
      );
    },
  );

  server.registerTool(
    "fmrl_whoami",
    {
      title: "This fmrl.site key",
      description: "The key's prefix, how many of this month's free publishes it has used, whether a browser is linked to it, a fresh link to link one (it carries the key ring), where the key ring is kept, and, when the Claude Code plugin launched this server, whether that plugin is up to date.",
      inputSchema: {},
      outputSchema: meOutput,
    },
    async () => {
      let ringLine = "";
      return run<MeResponse & Record<string, unknown>>(async (k) => {
        const me = await api.me(k);
        let ring: string | undefined;
        try {
          ring = await keys.ringFor(k);
          ringLine = keys.ringFromEnv ? RING_ENV_LINE : RING_FILE_LINE(keys.file);
        } catch (e) {
          ringLine = RING_UNSAVED_LINE(keys.file, errorText(e));
        }
        return (me.link_url && ring ? { ...me, link_url: withRing(me.link_url, k, ring) } : me) as MeResponse & Record<string, unknown>;
      }, (m) => meText(m, ringLine, pluginLine(plugin)));
    },
  );

  return server;
}
