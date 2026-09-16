import type { Stats } from "node:fs";
import { mkdtemp, unlink, writeFile } from "node:fs/promises";
import os, { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FmrlApi } from "../src/api.js";
import { openEnvelope } from "../src/crypto.js";
import { MAX_BYTES } from "../src/format.js";
import { KeyStore } from "../src/keys.js";
import { createServer, type ServerDeps } from "../src/server.js";
import { startFakeApi, type FakeApi } from "./fake-api.js";

let fake: FakeApi; let client: Client; let dir: string;
type ToolResult = { content: Array<{ type: string; text?: string }>; structuredContent?: Record<string, unknown>; isError?: boolean };
const call = async (name: string, args: Record<string, unknown> = {}): Promise<ToolResult> => (await client.callTool({ name, arguments: args })) as ToolResult;
const text = (r: ToolResult) => r.content.map((c) => c.text ?? "").join("\n");

beforeEach(async () => {
  fake = await startFakeApi();
  dir = await mkdtemp(path.join(tmpdir(), "fmrl-"));
  const api = new FmrlApi(fake.baseUrl);
  const keys = new KeyStore({ api, baseUrl: fake.baseUrl, file: path.join(dir, "credentials.json") });
  const server = createServer({ api, keys });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  client = new Client({ name: "test", version: "0" });
  await client.connect(ct);
});
afterEach(async () => { await client.close(); await fake.close(); });

describe("tools", () => {
  it("lists exactly the five contract tools", async () => {
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual(["fmrl_delete", "fmrl_get", "fmrl_publish", "fmrl_publish_file", "fmrl_whoami"]);
  });
  it("fmrl_publish mints a key on first use and returns url, expiry, the seven-days line and the manage link", async () => {
    const r = await call("fmrl_publish", { content: "# Hello", title: "Hello" });
    expect(r.isError).toBeFalsy();
    const t = text(r);
    const id = (r.structuredContent as { id: string }).id;
    expect(t.split("\n")).toEqual([
      `Published: https://fmrl.test/${id}`,
      "Expires 2026-09-15T12:00:00Z",
      "This page lasts seven days unless someone keeps it on the page itself.",
      `Manage link (removes the page; give it only to someone who should be able to): https://fmrl.test/manage/${id}#k=tok${id}`,
      `See your pages on fmrl.site: open https://fmrl.test/link/code${id} once in your browser (it works for an hour, and once).`,
    ]);
    expect(r.structuredContent).toMatchObject({ id, url: `https://fmrl.test/${id}`, status: "live" });
    expect(fake.requests.map((q) => q.path)).toEqual(["/api/v1/keys", "/api/v1/publish"]);
    expect(fake.requests[1].body).toEqual({ content: "# Hello", title: "Hello" });
  });
  it("fmrl_publish passes an explicit format", async () => {
    await call("fmrl_publish", { content: "x", format: "html" });
    expect(fake.requests.at(-1)?.body).toEqual({ content: "x", format: "html" });
  });
  it("fmrl_publish_file maps the extension, refuses others, and caps the size", async () => {
    const md = path.join(dir, "note.MD");
    await writeFile(md, "# From a file");
    const ok = await call("fmrl_publish_file", { path: md });
    expect(ok.isError).toBeFalsy();
    expect(fake.requests.at(-1)?.body).toEqual({ content: "# From a file", format: "md" });
    const pdf = path.join(dir, "x.pdf");
    await writeFile(pdf, "%PDF");
    const bad = await call("fmrl_publish_file", { path: pdf });
    expect(bad.isError).toBe(true);
    expect(text(bad)).toMatch(/\.html, \.htm, \.md, \.markdown, \.mdx, \.txt/);
    const big = path.join(dir, "big.md");
    await writeFile(big, "a".repeat(2 * 1024 * 1024 + 1));
    const tooBig = await call("fmrl_publish_file", { path: big });
    expect(tooBig.isError).toBe(true);
    expect(text(tooBig)).toBe("That's bigger than the 2 MiB limit.");
    expect(fake.requests.filter((q) => q.path === "/api/v1/publish")).toHaveLength(1);
  });
  it("fmrl_publish_file publishes a file of exactly MAX_BYTES", async () => {
    const exact = path.join(dir, "exact.md");
    await writeFile(exact, "a".repeat(MAX_BYTES));
    const r = await call("fmrl_publish_file", { path: exact });
    expect(r.isError).toBeFalsy();
    expect(fake.requests.filter((q) => q.path === "/api/v1/publish")).toHaveLength(1);
  });
  it("refuses a file over MAX_BYTES from the bounded read even when stat lies about the size", async () => {
    const big = path.join(dir, "lied-big.md");
    await writeFile(big, "a".repeat(MAX_BYTES + 1));
    const api2 = new FmrlApi(fake.baseUrl);
    const keys2 = new KeyStore({ api: api2, baseUrl: fake.baseUrl, file: path.join(dir, "credentials2.json") });
    const lyingStat = (async () => ({ size: 10 }) as unknown as Stats) as unknown as ServerDeps["stat"];
    const server2 = createServer({ api: api2, keys: keys2, stat: lyingStat });
    const [ct2, st2] = InMemoryTransport.createLinkedPair();
    await server2.connect(st2);
    const client2 = new Client({ name: "test3", version: "0" });
    await client2.connect(ct2);
    try {
      const r = (await client2.callTool({ name: "fmrl_publish_file", arguments: { path: big } })) as ToolResult;
      expect(r.isError).toBe(true);
      expect(text(r)).toBe("That's bigger than the 2 MiB limit.");
      expect(fake.requests.filter((q) => q.path === "/api/v1/publish")).toHaveLength(0);
    } finally {
      await client2.close();
      await server2.close();
    }
  });
  it("fmrl_get and fmrl_delete accept an id or a URL", async () => {
    const pub = await call("fmrl_publish", { content: "x" });
    const id = (pub.structuredContent as { id: string }).id;
    const got = await call("fmrl_get", { id: `https://fmrl.test/${id}/raw` });
    expect(got.isError).toBeFalsy();
    expect(text(got)).toContain(`https://fmrl.test/${id}`);
    expect(text(got)).toContain("This page lasts seven days unless someone keeps it on the page itself.");
    expect(got.structuredContent).toMatchObject({ id, status: "live", pinned: false });
    const del = await call("fmrl_delete", { id });
    expect(del.isError).toBeFalsy();
    expect(text(del)).toContain(`Removed page ${id}. It answers 410 from now on.`);
    const again = await call("fmrl_get", { id });
    expect(again.isError).toBe(true);
    expect(text(again)).toBe("That page was removed.");
    const junk = await call("fmrl_get", { id: "nope" });
    expect(junk.isError).toBe(true);
    expect(text(junk)).toMatch(/not a document id/);
  });
  it("fmrl_whoami reports the quota", async () => {
    const r = await call("fmrl_whoami");
    expect(r.isError).toBeFalsy();
    expect(text(r)).toMatch(/fmrl_\w{4}…: 0 of 25 publishes used this month, resets 2026-10-01T00:00:00Z/);
    expect(r.structuredContent).toMatchObject({ quota: { publishes: { used: 0, limit: 25 } } });
  });
  it("fmrl_publish says nothing about a link once the key is linked", async () => {
    const first = await call("fmrl_publish", { content: "# a" });
    fake.linked.add((fake.requests.at(-1)!.auth as string).slice(7));
    const r = await call("fmrl_publish", { content: "# b" });
    expect(text(first)).toContain("See your pages on fmrl.site");
    expect(text(r)).not.toContain("See your pages");
    expect(r.structuredContent).not.toHaveProperty("link_url");
  });
  it("fmrl_whoami says whether a browser is linked and always offers a link", async () => {
    const r = await call("fmrl_whoami");
    expect(text(r)).toContain("Not linked to any browser yet.");
    expect(text(r)).toContain("open https://fmrl.test/link/fresh (works for an hour, and once)");
    expect(r.structuredContent).toMatchObject({ linked_at: null, link_url: "https://fmrl.test/link/fresh" });
    fake.linked.add((fake.requests.at(-1)!.auth as string).slice(7));
    const again = await call("fmrl_whoami");
    expect(text(again)).toContain("Linked to a browser on 2026-09-16T12:00:00Z.");
    expect(again.structuredContent).toMatchObject({ linked_at: "2026-09-16T12:00:00Z" });
  });
  it("a 402 is a tool error with the reset time and is not retried", async () => {
    fake.quota = 0;
    const r = await call("fmrl_publish", { content: "x" });
    expect(r.isError).toBe(true);
    expect(text(r)).toBe("This key has used its free publishes for the month; it resets at 2026-10-01T00:00:00Z.");
    expect(fake.requests.filter((q) => q.path === "/api/v1/publish")).toHaveLength(1);
  });
  it("a 422 is a tool error with the API's message", async () => {
    const r = await call("fmrl_publish", { content: "PHISH" });
    expect(r.isError).toBe(true);
    expect(text(r)).toBe("That can't be shared: it looks like phishing: a well-known brand next to a sign-in prompt.");
  });
  it("a stored key that answers 401 is replaced once, transparently", async () => {
    await call("fmrl_whoami");
    fake.keys.clear();
    const r = await call("fmrl_whoami");
    expect(r.isError).toBeFalsy();
    expect(fake.requests.filter((q) => q.path === "/api/v1/keys")).toHaveLength(2);
  });
  it("a 429 on mint reports the retry time in minutes", async () => {
    fake.mintLimit = 0;
    const r = await call("fmrl_whoami");
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/Try again in 60 minutes\.$/);
  });
  it("fmrl_whoami reports a network error when the API is unreachable", async () => {
    const badDir = await mkdtemp(path.join(tmpdir(), "fmrl-"));
    const badApi = new FmrlApi("http://127.0.0.1:9");
    const badKeys = new KeyStore({ api: badApi, baseUrl: "http://127.0.0.1:9", file: path.join(badDir, "credentials.json") });
    const badServer = createServer({ api: badApi, keys: badKeys });
    const [ct2, st2] = InMemoryTransport.createLinkedPair();
    await badServer.connect(st2);
    const badClient = new Client({ name: "test2", version: "0" });
    await badClient.connect(ct2);
    try {
      const r = (await badClient.callTool({ name: "fmrl_whoami", arguments: {} })) as ToolResult;
      expect(r.isError).toBe(true);
      expect(text(r)).toMatch(/^Couldn't reach/);
    } finally {
      await badClient.close();
      await badServer.close();
    }
  });
  it("fmrl_publish_file expands a leading ~", async () => {
    if (process.platform === "win32") return;
    const name = `.fmrl-mcp-test-${Date.now()}.md`;
    const abs = path.join(os.homedir(), name);
    await writeFile(abs, "# Home file");
    try {
      const r = await call("fmrl_publish_file", { path: `~/${name}` });
      expect(r.isError).toBeFalsy();
      expect(fake.requests.at(-1)?.body).toEqual({ content: "# Home file", format: "md" });
    } finally {
      await unlink(abs);
    }
  });
  it("fmrl_publish_file rejects a non-UTF-8 file without publishing", async () => {
    const bad = path.join(dir, "bad.md");
    await writeFile(bad, Buffer.from([0xff, 0xfe, 0xfd, 0xfc]));
    const r = await call("fmrl_publish_file", { path: bad });
    expect(r.isError).toBe(true);
    expect(text(r)).toBe("That file isn't UTF-8 text.");
    expect(fake.requests.filter((q) => q.path === "/api/v1/publish")).toHaveLength(0);
  });
  it("fmrl_publish reports the server's 413 for oversized content", async () => {
    const r = await call("fmrl_publish", { content: "a".repeat(2 * 1024 * 1024 + 1) });
    expect(r.isError).toBe(true);
    expect(text(r)).toBe("That's bigger than the 2 MiB limit.");
  });
  it("fmrl_get renders a pinned page as kept forever with its CID", async () => {
    const pub = await call("fmrl_publish", { content: "x", title: "PINNED" });
    const id = (pub.structuredContent as { id: string }).id;
    const got = await call("fmrl_get", { id });
    expect(got.isError).toBeFalsy();
    expect(text(got)).toContain("kept forever (bafytest)");
    expect(got.structuredContent).toMatchObject({ pinned: true, expires_at: null, cid: "bafytest" });
  });
  it("fmrl_publish private: renders Markdown, sends an envelope with encrypted true, returns the key in the fragment", async () => {
    const r = await call("fmrl_publish", { content: "# Quiet\n\nhello", private: true });
    expect(r.isError).toBeFalsy();
    const body = fake.requests[1].body as { content: string; encrypted?: boolean; format?: string; title?: string };
    expect(body.encrypted).toBe(true);
    expect(body.format).toBe("html");
    expect(body.title).toBeUndefined();
    expect(body.content.startsWith('MARKYENC{"v":2,"alg":"aes-256-gcm","kdf":"none"')).toBe(true);
    const url = (r.structuredContent as { url: string }).url;
    const m = /#p=([A-Za-z0-9_-]{43})$/.exec(url);
    expect(m).not.toBeNull();
    const html = await openEnvelope(body.content, { key: m![1] });
    expect(html).toContain("<h1>Quiet</h1>");
    expect(html).toContain("<title>Quiet</title>");
    const t = text(r);
    expect(t).toContain(`Published: ${url}`);
    expect(t).toContain("private");
    expect(t).toContain("This page lasts seven days; a private page cannot be kept.");
    expect(t).not.toContain("keeps it");
    expect((r.structuredContent as { manage_url: string }).manage_url).not.toContain("#p=");

    const titled = await call("fmrl_publish", { content: "# Quiet\n\nhello", private: true, title: "Custom Title" });
    expect(titled.isError).toBeFalsy();
    const titledBody = fake.requests.at(-1)?.body as { content: string; title?: string };
    expect(titledBody.title).toBeUndefined();
    const titledKey = /#p=([A-Za-z0-9_-]{43})$/.exec((titled.structuredContent as { url: string }).url)![1];
    const titledHtml = await openEnvelope(titledBody.content, { key: titledKey });
    expect(titledHtml).toContain("<title>Custom Title</title>");
  });
  it("fmrl_publish passphrase: pbkdf2 envelope, no fragment", async () => {
    const r = await call("fmrl_publish", { content: "<h1>x</h1>", passphrase: "open sesame" });
    expect(r.isError).toBeFalsy();
    const body = fake.requests[1].body as { content: string; encrypted?: boolean };
    expect(body.encrypted).toBe(true);
    expect(body.content).toContain('"kdf":"pbkdf2"');
    const url = (r.structuredContent as { url: string }).url;
    expect(url).not.toContain("#");
    expect(await openEnvelope(body.content, { passphrase: "open sesame" })).toBe("<h1>x</h1>");
    const t = text(r);
    expect(t).toContain("passphrase");
    expect(t).toContain("This page lasts seven days; a private page cannot be kept.");
    expect(t).not.toContain("keeps it");
  });
  it("fmrl_publish_file private renders a .md file before sealing", async () => {
    const md = path.join(dir, "notes.md");
    await writeFile(md, "# Notes\n\n- one");
    const r = await call("fmrl_publish_file", { path: md, private: true });
    expect(r.isError).toBeFalsy();
    const body = fake.requests[1].body as { content: string; encrypted?: boolean; format?: string };
    expect(body.encrypted).toBe(true);
    expect(body.format).toBe("html");
    const key = /#p=([A-Za-z0-9_-]{43})$/.exec((r.structuredContent as { url: string }).url)![1];
    expect(await openEnvelope(body.content, { key })).toContain("<li>one</li>");
  });
  it("a public publish sends neither encrypted nor a rendered body", async () => {
    await call("fmrl_publish", { content: "# Plain" });
    expect(fake.requests[1].body).toEqual({ content: "# Plain" });
  });
  it("fmrl_publish private: whitespace-only content is refused before sending", async () => {
    const r = await call("fmrl_publish", { content: "  \n ", private: true });
    expect(r.isError).toBe(true);
    expect(fake.requests.some((q) => q.path === "/api/v1/publish")).toBe(false);
  });
  it("fmrl_publish public: whitespace-only content is refused before sending", async () => {
    const r = await call("fmrl_publish", { content: "  \n ", format: "md" });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("Nothing to publish");
    expect(fake.requests.some((q) => q.path === "/api/v1/publish")).toBe(false);
  });
  it("fmrl_publish private html: whitespace-only content is refused rather than sealed as a blank page", async () => {
    const r = await call("fmrl_publish", { content: " \t\n", format: "html", private: true });
    expect(r.isError).toBe(true);
    expect(fake.requests.some((q) => q.path === "/api/v1/publish")).toBe(false);
  });
  it("fmrl_publish private: content that seals over the 2 MiB cap is refused before sending, even though the plaintext is under it", async () => {
    const html = `<h1>x</h1>${"a".repeat(1_677_700)}`;
    expect(Buffer.byteLength(html, "utf8")).toBeLessThan(MAX_BYTES);
    const r = await call("fmrl_publish", { content: html, private: true });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("over the 2 MiB limit");
    expect(fake.requests.some((q) => q.path === "/api/v1/publish")).toBe(false);
  });
});
