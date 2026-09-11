import { open as fsOpen, stat as fsStat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ApiError, type DocResponse, type FmrlApi, type MeResponse, type PublishResponse } from "./api.js";
import { seal } from "./crypto.js";
import { MAX_BYTES, TOO_LARGE_MESSAGE, formatForPath } from "./format.js";
import { parseDocId } from "./ids.js";
import type { KeyStore } from "./keys.js";
import { firstHeading, looksLikeHTML, toHTML, wrapDocument } from "./markdown.js";

export interface ServerDeps {
  api: FmrlApi;
  keys: KeyStore;
  open?: typeof fsOpen;
  stat?: typeof fsStat;
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

function publishText(p: PublishResponse): string {
  return [
    `Published: ${p.url}`,
    `Expires ${p.expires_at}`,
    SEVEN_DAYS,
    `Manage link (removes the page; give it only to someone who should be able to): ${p.manage_url}`,
  ].join("\n");
}
export const PRIVATE_LINE = "This page is private: it was encrypted here before upload, and the key is the part of the link after #p=. fmrl.site cannot read or recover it.";
export const PASSPHRASE_LINE = "This page is private and needs the passphrase to open; the link alone shows nothing. fmrl.site cannot read or recover it.";

/** preparePrivate renders (if Markdown) and seals content, returning the request body and the link key. */
async function preparePrivate(content: string, format: "html" | "md" | undefined, passphrase: string | undefined): Promise<{ body: { content: string; format: "html"; encrypted: true }; key: string | null }> {
  let html = content;
  if (format === "md" || (format === undefined && !looksLikeHTML(content))) {
    const body = toHTML(content);
    html = wrapDocument(body, firstHeading(body));
  }
  const sealed = await seal(html, passphrase || undefined);
  const envBytes = Buffer.byteLength(sealed.envelope, "utf8");
  if (envBytes > MAX_BYTES) {
    throw new Error(`The encrypted page is ${envBytes} bytes, over the 2 MiB limit. Encryption adds about a third, so roughly 1.4 MB of HTML fits.`);
  }
  return { body: { content: sealed.envelope, format: "html", encrypted: true }, key: sealed.key };
}

function withKey(p: PublishResponse, key: string | null): PublishResponse {
  return key ? { ...p, url: `${p.url}#p=${key}` } : p;
}
function privateText(p: PublishResponse, passphrase: boolean): string {
  return [publishText(p), passphrase ? PASSPHRASE_LINE : PRIVATE_LINE].join("\n");
}

function docText(d: DocResponse): string {
  const kept = d.pinned ? `kept forever${d.cid ? ` (${d.cid})` : ""}` : `expires ${d.expires_at}`;
  return [`${d.url}: ${d.status}, ${d.format}, ${d.size} bytes, ${kept}.`, SEVEN_DAYS].join("\n");
}
function meText(m: MeResponse): string {
  const q = m.quota.publishes;
  return [`${m.prefix}…: ${q.used} of ${q.limit} publishes used this month, resets ${q.resets_at}.`, SEVEN_DAYS].join("\n");
}

const publishOutput = {
  id: z.string(), url: z.string(), raw_url: z.string(), manage_url: z.string(), expires_at: z.string(), status: z.string(),
};
const docOutput = {
  id: z.string(), url: z.string(), status: z.string(), format: z.string(), size: z.number(),
  expires_at: z.string().nullable(), pinned: z.boolean(), cid: z.string().optional(),
};
const meOutput = {
  prefix: z.string(), created_at: z.string(),
  quota: z.object({ publishes: z.object({ used: z.number(), limit: z.number(), resets_at: z.string() }) }),
};

/** createServer registers the five contract tools on an McpServer. deps.keys owns the key; deps.api speaks HTTP. */
export function createServer(deps: ServerDeps): McpServer {
  const { api, keys } = deps;
  const open = deps.open ?? fsOpen;
  const stat = deps.stat ?? fsStat;
  const server = new McpServer({ name: "fmrl", version: "0.1.0" });

  const run = async <T extends Record<string, unknown>>(fn: (key: string) => Promise<T>, render: (v: T) => string): Promise<ToolResult> => {
    try {
      const v = await keys.withKey(fn);
      return ok(render(v), v);
    } catch (e) {
      return fail(errorText(e));
    }
  };

  /** publishOrSeal is the shared branch behind fmrl_publish and fmrl_publish_file: publish as given, or seal first when private or passphrase was asked for. */
  const publishOrSeal = async (
    content: string, format: "html" | "md" | undefined, title: string | undefined, priv: boolean | undefined, passphrase: string | undefined,
  ): Promise<ToolResult> => {
    if (!priv && !passphrase) {
      return run<PublishResponse & Record<string, unknown>>((k) => api.publish(k, { content, format, title }) as Promise<PublishResponse & Record<string, unknown>>, publishText);
    }
    let prepared: Awaited<ReturnType<typeof preparePrivate>>;
    try {
      prepared = await preparePrivate(content, format, passphrase);
    } catch (e) {
      return fail(errorText(e));
    }
    return run<PublishResponse & Record<string, unknown>>(
      async (k) => withKey(await api.publish(k, prepared.body), prepared.key) as PublishResponse & Record<string, unknown>,
      (p) => privateText(p, Boolean(passphrase)),
    );
  };

  server.registerTool(
    "fmrl_publish",
    {
      title: "Publish a page to fmrl.site",
      description: "Publish HTML or Markdown as a page on fmrl.site and get its link. The page lasts seven days unless someone keeps it from the page itself. Pass private: true to encrypt it here first. Only call this when the user asked to share, send, or get a link for something.",
      inputSchema: {
        content: z.string().min(1).describe("The HTML or Markdown to publish (2 MiB at most)."),
        format: z.enum(["html", "md"]).optional().describe("html or md; leave out to let the server detect it."),
        title: z.string().optional().describe("Page title; the first heading is used when left out. Ignored for a private page: the server stores no title, and the encrypted document's own title is its first heading."),
        private: z.boolean().optional().describe("Encrypt the page here before upload; the returned link carries the key after #p=. The page has no title or preview on fmrl.site and cannot be recovered without the link."),
        passphrase: z.string().min(1).optional().describe("Encrypt with this passphrase instead of a link key (implies private). Readers type it on the page; the link alone shows nothing."),
      },
      outputSchema: publishOutput,
    },
    async ({ content, format, title, private: priv, passphrase }) => publishOrSeal(content, format, title, priv, passphrase),
  );

  server.registerTool(
    "fmrl_publish_file",
    {
      title: "Publish a file to fmrl.site",
      description: "Publish a .html, .htm, .md, .markdown, .mdx or .txt file (2 MiB at most) as a page on fmrl.site and get its link. Pass private: true to encrypt it here first. Only call this when the user asked to share the file.",
      inputSchema: {
        path: z.string().min(1).describe("Absolute path to the file (a leading ~ is expanded)."),
        title: z.string().optional().describe("Page title; the file's first heading is used when left out. Ignored for a private page: the server stores no title, and the encrypted document's own title is its first heading."),
        private: z.boolean().optional().describe("Encrypt the page here before upload; the returned link carries the key after #p=. The page has no title or preview on fmrl.site and cannot be recovered without the link."),
        passphrase: z.string().min(1).optional().describe("Encrypt with this passphrase instead of a link key (implies private). Readers type it on the page; the link alone shows nothing."),
      },
      outputSchema: publishOutput,
    },
    async ({ path: p, title, private: priv, passphrase }) => {
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
      return publishOrSeal(content, format, title, priv, passphrase);
    },
  );

  server.registerTool(
    "fmrl_get",
    {
      title: "Describe a fmrl.site page",
      description: "Look up a page by id or URL: status, format, size, expiry, and whether it has been kept.",
      inputSchema: { id: z.string().min(1).describe("A document id or any fmrl.site URL for it.") },
      outputSchema: docOutput,
    },
    async ({ id }) => {
      let docId: string;
      try { docId = parseDocId(id); } catch (e) { return fail(errorText(e)); }
      return run<DocResponse & Record<string, unknown>>((k) => api.get(k, docId) as Promise<DocResponse & Record<string, unknown>>, docText);
    },
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
      description: "The key's prefix and how many of this month's free publishes it has used.",
      inputSchema: {},
      outputSchema: meOutput,
    },
    async () => run<MeResponse & Record<string, unknown>>((k) => api.me(k) as Promise<MeResponse & Record<string, unknown>>, meText),
  );

  return server;
}
