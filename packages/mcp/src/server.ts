import { readFile as fsReadFile, stat as fsStat } from "node:fs/promises";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ApiError, type DocResponse, type FmrlApi, type MeResponse, type PublishResponse } from "./api.js";
import { MAX_BYTES, TOO_LARGE_MESSAGE, formatForPath } from "./format.js";
import { parseDocId } from "./ids.js";
import type { KeyStore } from "./keys.js";

export interface ServerDeps {
  api: FmrlApi;
  keys: KeyStore;
  readFile?: typeof fsReadFile;
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
  if (e instanceof ApiError) return e.resetsAt ? `${e.message} Resets at ${e.resetsAt}.` : e.message;
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
  const readFile = deps.readFile ?? fsReadFile;
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

  server.registerTool(
    "fmrl_publish",
    {
      title: "Publish a page to fmrl.site",
      description: "Publish HTML or Markdown as a page on fmrl.site and get its link. The page lasts seven days unless someone keeps it from the page itself. Only call this when the user asked to share, send, or get a link for something.",
      inputSchema: {
        content: z.string().min(1).describe("The HTML or Markdown to publish (2 MiB at most)."),
        format: z.enum(["html", "md"]).optional().describe("html or md; leave out to let the server detect it."),
        title: z.string().max(120).optional().describe("Page title; the first heading is used when left out."),
      },
      outputSchema: publishOutput,
    },
    async ({ content, format, title }) => run<PublishResponse & Record<string, unknown>>((k) => api.publish(k, { content, format, title }) as Promise<PublishResponse & Record<string, unknown>>, publishText),
  );

  server.registerTool(
    "fmrl_publish_file",
    {
      title: "Publish a file to fmrl.site",
      description: "Publish a .html, .htm, .md, .markdown, .mdx or .txt file (2 MiB at most) as a page on fmrl.site and get its link. Only call this when the user asked to share the file.",
      inputSchema: {
        path: z.string().min(1).describe("Path to the file."),
        title: z.string().max(120).optional().describe("Page title; the file's first heading is used when left out."),
      },
      outputSchema: publishOutput,
    },
    async ({ path: p, title }) => {
      let format: "html" | "md";
      let content: string;
      try {
        const resolved = path.resolve(p);
        format = formatForPath(resolved);
        const info = await stat(resolved);
        if (info.size > MAX_BYTES) return fail(TOO_LARGE_MESSAGE);
        content = await readFile(resolved, "utf8");
      } catch (e) {
        return fail(errorText(e));
      }
      return run<PublishResponse & Record<string, unknown>>((k) => api.publish(k, { content, format, title }) as Promise<PublishResponse & Record<string, unknown>>, publishText);
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
        (v) => `Removed ${v.url}. It answers 410 from now on.\n${SEVEN_DAYS}`,
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
