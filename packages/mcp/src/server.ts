import { open as fsOpen, stat as fsStat } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ApiError, type DocResponse, type Editor, type FmrlApi, type MeResponse, type PublishRequest, type PublishResponse } from "./api.js";
import { openRecord, seal, sealRecord, type OpenedRecord } from "./crypto.js";
import { MAX_BYTES, TOO_LARGE_MESSAGE, formatForPath } from "./format.js";
import { parseDocId, parsePageRef } from "./ids.js";
import { prefixOf, type KeyStore } from "./keys.js";
import { documentTitle, firstHeading, looksLikeHTML, readSource, toHTML, wrapDocument } from "./markdown.js";
import { openPrivatePage } from "./opener.js";
import type { PageStore } from "./pages.js";

// The version the server reports to MCP clients is the package's, read at
// runtime, so a release bump in package.json cannot leave this behind.
const { version: VERSION } = createRequire(import.meta.url)("../package.json") as { version: string };

export interface ServerDeps {
  api: FmrlApi;
  keys: KeyStore;
  /** pages holds the content keys and manage tokens of pages this machine has opened. */
  pages: PageStore;
  open?: typeof fsOpen;
  stat?: typeof fsStat;
  log?: (line: string) => void;
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

/** preparePrivate renders (if Markdown) and seals content, returning the request body, the link key, and the title the sealed record carries: the title given, else the first heading for Markdown, else the document's <title> or first heading for HTML. The request body never carries a title. */
async function preparePrivate(content: string, format: "html" | "md" | undefined, title: string | undefined): Promise<{ body: { content: string; format: "html"; encrypted: true }; key: string; title: string }> {
  let html = content;
  let name: string;
  if (format === "md" || (format === undefined && !looksLikeHTML(content))) {
    const body = toHTML(content);
    if (body.trim() === "") {
      throw new Error("Nothing to publish: the content rendered to an empty page.");
    }
    name = title || firstHeading(body);
    html = wrapDocument(body, name);
  } else {
    name = title || documentTitle(content);
  }
  const sealed = await seal(html);
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
function meText(m: MeResponse, ringLine: string): string {
  const q = m.quota.publishes;
  const linked = m.linked_at ? `Linked to a browser on ${m.linked_at}.` : "Not linked to any browser yet.";
  const lines = [`${m.prefix}…: ${q.used} of ${q.limit} publishes used this month, resets ${q.resets_at}.`, linked];
  if (m.link_url) lines.push(`To see this key's pages on fmrl.site, open ${m.link_url} (works for an hour, and once).${ringCarried(m.link_url)}`);
  return [...lines, ringLine, SEVEN_DAYS].join("\n");
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
const listOutput = { docs: z.array(z.object(pageOutput)) };
const meOutput = {
  prefix: z.string(), created_at: z.string(),
  quota: z.object({ publishes: z.object({ used: z.number(), limit: z.number(), resets_at: z.string() }) }),
  linked_at: z.string().nullable().optional(), link_url: z.string().optional(),
};

/** createServer registers the six tools on an McpServer. deps.keys owns the key; deps.api speaks HTTP. */
export function createServer(deps: ServerDeps): McpServer {
  const { api, keys, pages } = deps;
  const open = deps.open ?? fsOpen;
  const stat = deps.stat ?? fsStat;
  const server = new McpServer({ name: "fmrl", version: VERSION });

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

  const run = async <T extends Record<string, unknown>>(fn: (key: string) => Promise<T>, render: (v: T) => string): Promise<ToolResult> => {
    try {
      const v = await keys.withKey(fn);
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
      return run<PublishResponse & Record<string, unknown>>(async (k) => (await publishAs(k, { content, format, title })) as PublishResponse & Record<string, unknown>, publishText);
    }
    let prepared: Awaited<ReturnType<typeof preparePrivate>>;
    try {
      prepared = await preparePrivate(content, format, title);
    } catch (e) {
      return fail(errorText(e));
    }
    return run<PublishResponse & Record<string, unknown>>(
      async (k) => withFragment(await publishAs(k, prepared.body, { key: prepared.key, title: prepared.title }), prepared.key) as PublishResponse & Record<string, unknown>,
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
      description: "The key's prefix, how many of this month's free publishes it has used, whether a browser is linked to it, a fresh link to link one (it carries the key ring), and where the key ring is kept.",
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
      }, (m) => meText(m, ringLine));
    },
  );

  return server;
}
