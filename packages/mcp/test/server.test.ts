import { mkdtemp, unlink, writeFile } from "node:fs/promises";
import os, { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FmrlApi } from "../src/api.js";
import { KeyStore } from "../src/keys.js";
import { createServer } from "../src/server.js";
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
});
