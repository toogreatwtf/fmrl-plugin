import type { Stats } from "node:fs";
import { mkdir, mkdtemp, unlink, writeFile } from "node:fs/promises";
import os, { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FmrlApi } from "../src/api.js";
import { readCredentials, writeCredentials } from "../src/credentials.js";
import { newRing, openEnvelope, openRecord, seal, sealRecord } from "../src/crypto.js";
import { MAX_BYTES } from "../src/format.js";
import { KeyStore } from "../src/keys.js";
import { PageStore } from "../src/pages.js";
import { createServer, LIST_EMPTY, NOT_HELD_LINE, RING_ENV_LINE, RING_FILE_LINE, SEVEN_DAYS_PRIVATE, VERSION, type ServerDeps } from "../src/server.js";
import { startFakeApi, type FakeApi } from "./fake-api.js";

let fake: FakeApi; let client: Client; let dir: string; let credFile: string; let pagesFile: string;
type ToolResult = { content: Array<{ type: string; text?: string }>; structuredContent?: Record<string, unknown>; isError?: boolean };
const call = async (name: string, args: Record<string, unknown> = {}): Promise<ToolResult> => (await client.callTool({ name, arguments: args })) as ToolResult;
const text = (r: ToolResult) => r.content.map((c) => c.text ?? "").join("\n");
const ringInFile = async () => (await readCredentials(credFile)).keys[fake.baseUrl]?.ring;
// The browser's #r= grammar (static/fmrl.js ringsFromFragment).
const RING_PAIR = /#r=([A-Za-z0-9_]{1,16})\.([A-Za-z0-9_-]{43})$/;
const keyOf = (q: { auth?: string }) => (q.auth as string).slice("Bearer ".length);
// The first publish request: naming the key (GET /me) comes before the first tool call's own work.
const firstPublish = () => fake.requests.find((q) => q.path === "/api/v1/publish")!;
const pagesAt = () => new PageStore(fake.baseUrl, pagesFile);
const connect = async (deps: Omit<ServerDeps, "pages"> & Partial<Pick<ServerDeps, "pages">>, clientName = "extra"): Promise<Client> => {
  const s = createServer({ pages: pagesAt(), ...deps });
  const [c, t] = InMemoryTransport.createLinkedPair();
  await s.connect(t);
  const cl = new Client({ name: clientName, version: "0" });
  await cl.connect(c);
  return cl;
};

beforeEach(async () => {
  fake = await startFakeApi();
  dir = await mkdtemp(path.join(tmpdir(), "fmrl-"));
  credFile = path.join(dir, "credentials.json");
  pagesFile = path.join(dir, "pages.json");
  const api = new FmrlApi(fake.baseUrl);
  const keys = new KeyStore({ api, baseUrl: fake.baseUrl, file: credFile });
  const server = createServer({ api, keys, pages: pagesAt() });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  client = new Client({ name: "test", version: "0" });
  await client.connect(ct);
});
afterEach(async () => { await client.close(); await fake.close(); });

describe("tools", () => {
  it("lists exactly the nine tools", async () => {
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual(["fmrl_delete", "fmrl_edit", "fmrl_get", "fmrl_inbox", "fmrl_list", "fmrl_publish", "fmrl_publish_file", "fmrl_watch", "fmrl_whoami"]);
  });
  it("fmrl_publish mints a key on first use and returns url, expiry, the seven-days line and the manage link", async () => {
    const r = await call("fmrl_publish", { content: "# Hello", title: "Hello" });
    expect(r.isError).toBeFalsy();
    const t = text(r);
    const id = (r.structuredContent as { id: string }).id;
    const prefix = keyOf(firstPublish()).slice(0, 9);
    const ring = await ringInFile();
    expect(ring).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(t.split("\n")).toEqual([
      `Published: https://fmrl.test/${id}`,
      "Expires 2026-09-15T12:00:00Z",
      "This page lasts seven days unless someone keeps it on the page itself.",
      `Manage link (removes the page; give it only to someone who should be able to): https://fmrl.test/manage/${id}#k=tok${id}manage0`,
      `See your pages on fmrl.site: open https://fmrl.test/link/code${id}#r=${prefix}.${ring} once in your browser (it works for an hour, and once). It also carries the ring that lets that browser open your private pages.`,
    ]);
    expect(r.structuredContent).toMatchObject({ id, url: `https://fmrl.test/${id}`, status: "live" });
    expect(r.structuredContent).toMatchObject({ link_url: `https://fmrl.test/link/code${id}#r=${prefix}.${ring}` });
    expect(fake.requests.map((q) => q.path)).toEqual(["/api/v1/keys", "/api/v1/me", "/api/v1/me", "/api/v1/publish"]);
    expect(firstPublish().body).toEqual({ content: "# Hello", title: "Hello" });
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
    const server2 = createServer({ api: api2, keys: keys2, pages: pagesAt(), stat: lyingStat });
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
    expect(text(junk)).toMatch(/not a page id/);
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
    expect(text(r)).toContain("open https://fmrl.test/link/fresh#r=");
    expect(r.structuredContent).toMatchObject({ linked_at: null, link_url: expect.stringMatching(/^https:\/\/fmrl\.test\/link\/fresh#r=/) });
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
    const badServer = createServer({ api: badApi, keys: badKeys, pages: new PageStore("http://127.0.0.1:9", path.join(badDir, "pages.json")) });
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
    const body = firstPublish().body as { content: string; encrypted?: boolean; format?: string; title?: string };
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
  it("fmrl_publish refuses a passphrase argument: there is no passphrase mode", async () => {
    const r = await call("fmrl_publish", { content: "<h1>x</h1>", passphrase: "open sesame" });
    expect(r.isError).toBe(true);
    expect(fake.requests).toHaveLength(0); // refused before the handler ran: no key mint, nothing published
  });
  it("fmrl_publish_file private renders a .md file before sealing", async () => {
    const md = path.join(dir, "notes.md");
    await writeFile(md, "# Notes\n\n- one");
    const r = await call("fmrl_publish_file", { path: md, private: true });
    expect(r.isError).toBeFalsy();
    const body = firstPublish().body as { content: string; encrypted?: boolean; format?: string };
    expect(body.encrypted).toBe(true);
    expect(body.format).toBe("html");
    const key = /#p=([A-Za-z0-9_-]{43})$/.exec((r.structuredContent as { url: string }).url)![1];
    expect(await openEnvelope(body.content, { key })).toContain("<li>one</li>");
  });
  it("a public publish sends neither encrypted nor a rendered body", async () => {
    await call("fmrl_publish", { content: "# Plain" });
    expect(firstPublish().body).toEqual({ content: "# Plain" });
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
  it("fmrl_publish private: seals the page's key and title under the ring, and the link carries that ring", async () => {
    const r = await call("fmrl_publish", { content: "# Quiet\n\nhello", private: true });
    expect(r.isError).toBeFalsy();
    const body = firstPublish().body as { sealed?: string };
    const pageKey = /#p=([A-Za-z0-9_-]{43})$/.exec((r.structuredContent as { url: string }).url)![1];
    const ring = (await ringInFile())!;
    expect(await openRecord(ring, body.sealed!)).toEqual({ key: pageKey, title: "Quiet" });
    const pair = RING_PAIR.exec((r.structuredContent as { link_url: string }).link_url)!;
    expect(pair[1]).toBe(keyOf(firstPublish()).slice(0, 9));
    expect(pair[2]).toBe(ring);
    // The ring shows in the reply only inside the link.
    expect(text(r).split(ring)).toHaveLength(2);
  });
  it("fmrl_publish private html: the record carries the explicit title, else the <title>", async () => {
    const html = "<!DOCTYPE html><html><head><title>Board notes</title></head><body><h1>Other</h1></body></html>";
    await call("fmrl_publish", { content: html, private: true });
    const ring = (await ringInFile())!;
    const first = fake.requests.at(-1)!.body as { sealed: string };
    expect((await openRecord(ring, first.sealed)).title).toBe("Board notes");
    await call("fmrl_publish", { content: html, private: true, title: "Custom" });
    const second = fake.requests.at(-1)!.body as { sealed: string };
    expect((await openRecord(ring, second.sealed)).title).toBe("Custom");
  });
  it("a publish with no link to relay mints no ring", async () => {
    const key = "fmrl_" + "L".repeat(32);
    await writeCredentials(credFile, { version: 1, keys: { [fake.baseUrl]: { key, prefix: key.slice(0, 9), created_at: "x" } } });
    fake.keys.add(key);
    fake.linked.add(key);
    const r = await call("fmrl_publish", { content: "# a" });
    expect(r.structuredContent).not.toHaveProperty("link_url");
    expect(await ringInFile()).toBeUndefined();
  });
  it("a retry after a 401 seals under the replacement key's ring", async () => {
    const oldRing = newRing();
    await writeCredentials(credFile, { version: 1, keys: { [fake.baseUrl]: { key: "fmrl_" + "S".repeat(32), prefix: "fmrl_SSSS", created_at: "x", ring: oldRing } } });
    const r = await call("fmrl_publish", { content: "# Again", private: true });
    expect(r.isError).toBeFalsy();
    const saved = await readCredentials(credFile);
    expect(saved.rings).toEqual({ fmrl_SSSS: oldRing });
    const ring = saved.keys[fake.baseUrl].ring!;
    const last = fake.requests.filter((q) => q.path === "/api/v1/publish").at(-1)!;
    const pageKey = /#p=([A-Za-z0-9_-]{43})$/.exec((r.structuredContent as { url: string }).url)![1];
    expect(await openRecord(ring, (last.body as { sealed: string }).sealed)).toEqual({ key: pageKey, title: "Again" });
    expect(RING_PAIR.exec((r.structuredContent as { link_url: string }).link_url)![2]).toBe(ring);
  });
  it("a ring that cannot be saved never costs the publish", async () => {
    const blocker = path.join(dir, "not-a-dir");
    await writeFile(blocker, "x");
    const envKey = "fmrl_" + "N".repeat(32);
    fake.keys.add(envKey);
    const logs: string[] = [];
    const api2 = new FmrlApi(fake.baseUrl);
    const keys2 = new KeyStore({ api: api2, baseUrl: fake.baseUrl, file: path.join(blocker, "credentials.json"), apiKeyFromEnv: envKey });
    const client2 = await connect({ api: api2, keys: keys2, log: (s) => logs.push(s) });
    try {
      const r = (await client2.callTool({ name: "fmrl_publish", arguments: { content: "# Still", private: true } })) as ToolResult;
      expect(r.isError).toBeFalsy();
      expect(fake.requests.at(-1)!.body as Record<string, unknown>).not.toHaveProperty("sealed");
      expect((r.structuredContent as { url: string }).url).toMatch(/#p=[A-Za-z0-9_-]{43}$/);
      expect((r.structuredContent as { link_url: string }).link_url).not.toContain("#r=");
      // A link without #r= must not claim to carry the ring.
      expect(text(r)).toContain("See your pages on fmrl.site: open ");
      expect(text(r)).not.toContain("It also carries the ring");
      expect(logs.join("\n")).toMatch(/couldn't save a key ring/);
      const who = (await client2.callTool({ name: "fmrl_whoami", arguments: {} })) as ToolResult;
      expect(text(who)).toContain(`Couldn't save a key ring to ${path.join(blocker, "credentials.json")} (`);
      expect(text(who)).toContain("To see this key's pages on fmrl.site, open ");
      expect(text(who)).not.toContain("It also carries the ring");
    } finally {
      await client2.close();
    }
  });
  it("fmrl_publish private: a title that seals over 1 KiB is refused before publishing", async () => {
    const r = await call("fmrl_publish", { content: "# x", private: true, title: "\u0001".repeat(200) });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/over the 1024-byte limit; pass a shorter title\.$/);
    expect(fake.requests.some((q) => q.path === "/api/v1/publish")).toBe(false);
  });
  it("fmrl_whoami mints the ring, carries it on the link, and names the file to back up", async () => {
    const r = await call("fmrl_whoami");
    expect(r.isError).toBeFalsy();
    const ring = (await ringInFile())!;
    const prefix = keyOf(fake.requests.at(-1)!).slice(0, 9);
    expect(ring).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(r.structuredContent).toMatchObject({ link_url: `https://fmrl.test/link/fresh#r=${prefix}.${ring}` });
    expect(text(r)).toContain(`open https://fmrl.test/link/fresh#r=${prefix}.${ring} (works for an hour, and once). It also carries the ring that lets that browser open your private pages.`);
    expect(text(r)).toContain(RING_FILE_LINE(credFile));
    expect(RING_FILE_LINE(credFile)).toBe(`Your key ring is in ${credFile}; back up that file to keep every page's key.`);
    expect(text(r).split(ring)).toHaveLength(2);
  });
  it("fmrl_whoami with FMRL_RING carries that ring and says where it comes from", async () => {
    const envRing = newRing();
    const api2 = new FmrlApi(fake.baseUrl);
    const keys2 = new KeyStore({ api: api2, baseUrl: fake.baseUrl, file: path.join(dir, "env-ring.json"), ringFromEnv: envRing });
    const client2 = await connect({ api: api2, keys: keys2 });
    try {
      const r = (await client2.callTool({ name: "fmrl_whoami", arguments: {} })) as ToolResult;
      expect(RING_PAIR.exec((r.structuredContent as { link_url: string }).link_url)![2]).toBe(envRing);
      expect(text(r)).toContain(RING_ENV_LINE);
      expect(text(r)).not.toContain("Your key ring is in");
    } finally {
      await client2.close();
    }
  });
  it("fmrl_list says so when the key has no pages", async () => {
    const r = await call("fmrl_list");
    expect(r.isError).toBeFalsy();
    expect(text(r)).toBe(LIST_EMPTY);
    expect(r.structuredContent).toEqual({ docs: [] });
  });
  it("fmrl_list hands back a private page's title and keyed link, and a public page's url, newest first", async () => {
    const pub = await call("fmrl_publish", { content: "# Open" });
    const priv = await call("fmrl_publish", { content: "# Quiet\n\nhello", private: true });
    const pubId = (pub.structuredContent as { id: string }).id;
    const { id: privId, url: privUrl } = priv.structuredContent as { id: string; url: string };
    const r = await call("fmrl_list");
    expect(text(r).split("\n")).toEqual([
      "2 pages on this key, newest first:",
      `- Quiet — ${privUrl} — expires 2026-09-15T12:00:00Z`,
      `- https://fmrl.test/${pubId} — expires 2026-09-15T12:00:00Z`,
    ]);
    const docs = (r.structuredContent as { docs: Array<Record<string, unknown>> }).docs;
    expect(docs[0]).toMatchObject({ id: privId, url: privUrl, private: true, key_held: true, title: "Quiet" });
    expect(docs[0]).not.toHaveProperty("sealed");
    expect(docs[1]).toMatchObject({ id: pubId, url: `https://fmrl.test/${pubId}`, private: false });
    expect(docs[1]).not.toHaveProperty("key_held");
    expect(fake.requests.at(-1)).toMatchObject({ method: "GET", path: "/api/v1/docs" });
  });
  it("fmrl_list names a page whose key it cannot open, and opens one under a replaced key's ring", async () => {
    const mine = await call("fmrl_publish", { content: "# Mine", private: true });
    const mineUrl = (mine.structuredContent as { url: string }).url;
    const key = keyOf(fake.requests.at(-1)!);
    const oldRing = newRing();
    const saved = await readCredentials(credFile);
    saved.rings = { fmrl_OLD1: oldRing };
    await writeCredentials(credFile, saved);
    const doc = (id: string, extra: Partial<{ sealed: string; status: string; owner: string }>) =>
      fake.docs.set(id, { id, owner: key, format: "html", size: 1, encrypted: true, ...extra });
    doc("aaaaaaaaaaaa", { sealed: await sealRecord(newRing(), "A".repeat(43), "Theirs") });
    doc("bbbbbbbbbbbb", {});
    doc("cccccccccccc", { sealed: await sealRecord(oldRing, "B".repeat(43), "Before"), status: "quarantined" });
    doc("dddddddddddd", { owner: "fmrl_" + "Z".repeat(32) });
    expect(text(await call("fmrl_list")).split("\n")).toEqual([
      "4 pages on this key, newest first:",
      `- Before — https://fmrl.test/cccccccccccc#p=${"B".repeat(43)} — expires 2026-09-15T12:00:00Z, quarantined`,
      "- private page (key not held here) — https://fmrl.test/bbbbbbbbbbbb — expires 2026-09-15T12:00:00Z",
      "- private page (key not held here) — https://fmrl.test/aaaaaaaaaaaa — expires 2026-09-15T12:00:00Z",
      `- Mine — ${mineUrl} — expires 2026-09-15T12:00:00Z`,
    ]);
  });
  it("fmrl_get hands back a private page's title and keyed link to the key that owns it", async () => {
    const priv = await call("fmrl_publish", { content: "# Quiet", private: true });
    const { id, url } = priv.structuredContent as { id: string; url: string };
    const got = await call("fmrl_get", { id });
    expect(got.isError).toBeFalsy();
    const [first, revLine, second, blank] = text(got).split("\n");
    expect(first.startsWith(`Quiet — ${url}: live, html, `)).toBe(true);
    expect(first.endsWith(" bytes, expires 2026-09-15T12:00:00Z.")).toBe(true);
    expect(revLine).toMatch(/^Revision 1 of 1, edited by test \(fmrl_\w{4}…\) at 2026-09-08T12:00:00\.000Z\.$/);
    expect(second).toBe(SEVEN_DAYS_PRIVATE);
    expect(blank).toBe("");
    expect(got.structuredContent).toMatchObject({ id, url, private: true, key_held: true, title: "Quiet" });
    expect(got.structuredContent).not.toHaveProperty("sealed");
  });
  it("fmrl_get says a private page's key is not held here when another key owns it", async () => {
    const priv = await call("fmrl_publish", { content: "# Theirs", private: true });
    const id = (priv.structuredContent as { id: string }).id;
    fake.docs.get(id)!.owner = "fmrl_" + "Z".repeat(32);
    await unlink(pagesFile); // publishing remembered the key; this machine is one that never held it
    const got = await call("fmrl_get", { id });
    expect(got.isError).toBeFalsy();
    expect(text(got)).toContain(NOT_HELD_LINE);
    expect(text(got)).toContain(SEVEN_DAYS_PRIVATE);
    expect(got.structuredContent).toMatchObject({ id, url: `https://fmrl.test/${id}`, private: true, key_held: false });
  });
});

describe("fmrl_get reads the page", () => {
  const OTHER = "fmrl_" + "Z".repeat(32);
  const MANAGE = "m".repeat(22);
  const NOTE = "private: pass the link with #p=<key> to read it";
  // sourceBlock is static/fmrl.js's: "&" as &amp; then "<" as &lt;.
  const sourceBlock = (src: string) => `<script type="text/x-fmrl-source" data-format="md">${src.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</script>`;
  /** plantPrivate puts a private page another key owns into the fake, sealed under a fresh key, the way a browser share would leave it. */
  const plantPrivate = async (html: string, extra: { owner?: string; sealed?: string } = {}) => {
    const { envelope, key } = await seal(html);
    const id = "pppppppppppp";
    fake.docs.set(id, {
      id, owner: extra.owner ?? OTHER, format: "html", size: envelope.length, encrypted: true, sealed: extra.sealed, rev: 1, manageToken: MANAGE,
      revisions: [{ rev: 1, at: "2026-09-08T12:00:00.000Z", size: envelope.length, sha256: "x", title: "", source: "browser", format: "html", content: envelope, editor: { kind: "session" } }],
    });
    return { id, key };
  };
  const stored = (id: string) => pagesAt().get(id);

  it("describes the tool as the brief words it", async () => {
    const tool = (await client.listTools()).tools.find((t) => t.name === "fmrl_get")!;
    expect(tool.description).toBe("Read a page by id or link: its metadata and, for revision `rev` (default the latest), its content. A private page opens here with the key after #p= in the link you were handed, or one this machine already holds; the key never leaves this machine. Reading a revision of a page you watch marks it seen.");
  });
  it("reads a public Markdown page's latest revision: its source, its format, and who wrote it", async () => {
    const pub = await call("fmrl_publish", { content: "# Hello\n\nworld", format: "md" });
    const id = (pub.structuredContent as { id: string }).id;
    const prefix = keyOf(fake.requests.at(-1)!).slice(0, 9);
    const got = await call("fmrl_get", { id: `https://fmrl.test/${id}` });
    expect(got.isError).toBeFalsy();
    expect(got.structuredContent).toMatchObject({
      id, url: `https://fmrl.test/${id}`, private: false, rev: 1, latest_rev: 1,
      editor: { kind: "key", key: prefix, name: "test" }, content: "# Hello\n\nworld", content_format: "md",
    });
    expect(got.structuredContent).not.toHaveProperty("content_note");
    expect(fake.requests.at(-1)).toMatchObject({ method: "GET", path: `/api/v1/docs/${id}/revisions/1` });
    const lines = text(got).split("\n");
    expect(lines[0]).toMatch(new RegExp(`^https://fmrl\\.test/${id}: live, md, `));
    expect(lines[1]).toBe(`Revision 1 of 1, edited by test (${prefix}…) at 2026-09-08T12:00:00.000Z.`);
    expect(text(got).endsWith("\n\n# Hello\n\nworld")).toBe(true);
  });
  it("reads an older revision when rev is given, and the latest otherwise", async () => {
    const pub = await call("fmrl_publish", { content: "# One", format: "md" });
    const id = (pub.structuredContent as { id: string }).id;
    const key = keyOf(fake.requests.at(-1)!);
    fake.labels.set(key, "claude-code");
    await new FmrlApi(fake.baseUrl).update(key, id, { content: "# Two", format: "md" });
    const old = await call("fmrl_get", { id, rev: 1 });
    expect(old.structuredContent).toMatchObject({ rev: 1, latest_rev: 2, content: "# One", content_format: "md" });
    const latest = await call("fmrl_get", { id });
    expect(latest.structuredContent).toMatchObject({ rev: 2, latest_rev: 2, content: "# Two", editor: { kind: "key", key: key.slice(0, 9), name: "claude-code" } });
    expect(text(latest)).toContain(`Revision 2 of 2, edited by claude-code (${key.slice(0, 9)}…) at `);
    const bad = await call("fmrl_get", { id, rev: 0 });
    expect(bad.isError).toBe(true);
    const missing = await call("fmrl_get", { id, rev: 9 });
    expect(missing.isError).toBe(true);
    expect(text(missing)).toBe("No such revision of that page.");
  });
  it("opens a private page with the key in the link it was handed, then remembers that key and the manage token", async () => {
    const { id, key } = await plantPrivate("<!DOCTYPE html><html><head><title>Plan</title></head><body><h1>Plan</h1></body></html>");
    const got = await call("fmrl_get", { id: `https://fmrl.test/manage/${id}#k=${MANAGE}&p=${key}` });
    expect(got.isError).toBeFalsy();
    expect(got.structuredContent).toMatchObject({
      id, private: true, key_held: true, url: `https://fmrl.test/${id}#p=${key}`, title: "Plan",
      rev: 1, latest_rev: 1, editor: { kind: "session" }, content_format: "html",
    });
    expect((got.structuredContent as { content: string }).content).toContain("<h1>Plan</h1>");
    expect(await stored(id)).toEqual({ key, manage: MANAGE });
    // The key was never sent anywhere.
    expect(JSON.stringify(fake.requests)).not.toContain(key);
  });
  it("opens a private page with a key this machine already holds", async () => {
    const { id, key } = await plantPrivate("<p>held</p>");
    await pagesAt().remember(id, { key });
    const got = await call("fmrl_get", { id });
    expect(got.structuredContent).toMatchObject({ key_held: true, url: `https://fmrl.test/${id}#p=${key}`, content: "<p>held</p>", content_format: "html" });
  });
  it("opens the owner's private page through its ring, and returns the HTML when there is no source block", async () => {
    const priv = await call("fmrl_publish", { content: "# Quiet\n\nhello", private: true });
    const { id, url } = priv.structuredContent as { id: string; url: string };
    const got = await call("fmrl_get", { id });
    expect(got.structuredContent).toMatchObject({ url, key_held: true, title: "Quiet", content_format: "html" });
    expect((got.structuredContent as { content: string }).content).toContain("<h1>Quiet</h1>");
  });
  it("a fragment key that doesn't open the page is not remembered, and the page reads as metadata and a note", async () => {
    const { id } = await plantPrivate("<p>secret</p>");
    const wrong = "W".repeat(43);
    const got = await call("fmrl_get", { id: `https://fmrl.test/${id}#p=${wrong}&k=${MANAGE}` });
    expect(got.isError).toBeFalsy();
    expect(got.structuredContent).toMatchObject({ id, private: true, key_held: false, url: `https://fmrl.test/${id}`, rev: 1, latest_rev: 1, content_note: NOTE });
    expect(got.structuredContent).not.toHaveProperty("content");
    expect(got.structuredContent).not.toHaveProperty("content_format");
    expect(text(got).endsWith(`\n\n${NOTE}`)).toBe(true);
    expect(text(got)).not.toContain(wrong);
    expect(await stored(id)).toEqual({});
  });
  it("returns the Markdown source block of a private page, entity-unescaped exactly as the browser wrote it", async () => {
    const src = "# Title\n\na <b>bold</b> & c &lt; d &amp; e </script> f";
    const { id, key } = await plantPrivate(`<!DOCTYPE html><html><body><h1>Title</h1>\n${sourceBlock(src)}\n</body></html>`);
    const got = await call("fmrl_get", { id: `https://fmrl.test/${id}#p=${key}` });
    expect(got.structuredContent).toMatchObject({ content: src, content_format: "md" });
    expect(text(got).endsWith(`\n\n${src}`)).toBe(true);
  });
  it("an invalid link never echoes the key it carries", async () => {
    const key = "Q".repeat(43);
    const got = await call("fmrl_get", { id: `https://fmrl.test/about#p=${key}` });
    expect(got.isError).toBe(true);
    expect(text(got)).not.toContain(key);
  });
});

describe("fmrl_edit", () => {
  const PRIVATE_NEEDS_KEY = "This page is private: pass its link with #p=<key>.";
  const puts = () => fake.requests.filter((q) => q.method === "PUT");
  /** second is another agent: its own key, its own credentials and page store, the same API. */
  const second = async () => {
    const api2 = new FmrlApi(fake.baseUrl);
    const keys2 = new KeyStore({ api: api2, baseUrl: fake.baseUrl, file: path.join(dir, "credentials-b.json") });
    const pages2 = new PageStore(fake.baseUrl, path.join(dir, "pages-b.json"));
    const c = await connect({ api: api2, keys: keys2, pages: pages2 });
    return { call: async (name: string, args: Record<string, unknown> = {}) => (await c.callTool({ name, arguments: args })) as ToolResult, pages: pages2 };
  };
  const manageTok = (manageUrl: string) => manageUrl.slice(manageUrl.indexOf("#k=") + 3);

  it("describes the tool as the brief words it", async () => {
    const tool = (await client.listTools()).tools.find((t) => t.name === "fmrl_edit")!;
    expect(tool.description).toBe("Replace a page's content with a new revision. Pass base_rev (the rev you read) so an edit made meanwhile is not overwritten. Works on your own pages and on any page whose manage link you were given; a private page stays private under its same key, so every existing link keeps opening it.");
  });
  it("publishing remembers the page's manage token, and a private page's key", async () => {
    const pub = await call("fmrl_publish", { content: "# Open" });
    const { id, manage_url } = pub.structuredContent as { id: string; manage_url: string };
    expect(await pagesAt().get(id)).toEqual({ manage: manageTok(manage_url) });
    const priv = await call("fmrl_publish", { content: "# Closed", private: true });
    const p = priv.structuredContent as { id: string; url: string; manage_url: string };
    expect(await pagesAt().get(p.id)).toEqual({ key: p.url.split("#p=")[1], manage: manageTok(p.manage_url) });
  });
  it("the owner edits its own public page, and the next read is the new revision", async () => {
    const pub = await call("fmrl_publish", { content: "# One", format: "md" });
    const id = (pub.structuredContent as { id: string }).id;
    const r = await call("fmrl_edit", { id, content: "# Two", format: "md", title: "Two", base_rev: 1 });
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent).toEqual({ id, url: `https://fmrl.test/${id}`, rev: 2 });
    expect(puts()).toHaveLength(1);
    expect(puts()[0]).toMatchObject({ path: `/api/v1/docs/${id}`, body: { content: "# Two", format: "md", title: "Two", base_rev: 1 } });
    const got = await call("fmrl_get", { id });
    expect(got.structuredContent).toMatchObject({ rev: 2, latest_rev: 2, content: "# Two" });
  });
  it("another key edits with the manage link passed once, then by bare id, the token remembered only once it worked", async () => {
    const pub = await call("fmrl_publish", { content: "# Shared", format: "md" });
    const { id, manage_url } = pub.structuredContent as { id: string; manage_url: string };
    const b = await second();

    const bare = await b.call("fmrl_edit", { id, content: "# Nope" });
    expect(bare.isError).toBe(true);
    expect(text(bare)).toBe(`You can edit this page with its manage link (https://fmrl.test/manage/${id}#k=…); pass it as id once and it is remembered.`);

    const forged = await b.call("fmrl_edit", { id: `https://fmrl.test/manage/${id}#k=${"f".repeat(22)}`, content: "# Forged" });
    expect(forged.isError).toBe(true);
    expect(await b.pages.get(id)).toEqual({});

    const once = await b.call("fmrl_edit", { id: manage_url, content: "# Edited by B", base_rev: 1 });
    expect(once.isError).toBeFalsy();
    expect(once.structuredContent).toEqual({ id, url: `https://fmrl.test/${id}`, rev: 2 });
    expect(puts().at(-1)?.manageToken).toBe(manageTok(manage_url));
    expect(await b.pages.get(id)).toEqual({ manage: manageTok(manage_url) });

    const again = await b.call("fmrl_edit", { id, content: "# Again", base_rev: 2 });
    expect(again.isError).toBeFalsy();
    expect(again.structuredContent).toMatchObject({ rev: 3 });
    expect(puts().at(-1)?.manageToken).toBe(manageTok(manage_url));
  });
  it("re-seals a private page under its same key, so the original link reads the new revision", async () => {
    const priv = await call("fmrl_publish", { content: "# Plan\n\nfirst", private: true });
    const { id, url, manage_url } = priv.structuredContent as { id: string; url: string; manage_url: string };
    const key = url.split("#p=")[1];
    const b = await second();

    const r = await b.call("fmrl_edit", { id: `https://fmrl.test/manage/${id}#p=${key}&k=${manageTok(manage_url)}`, content: "# Plan v2\n\nsecond", format: "md", title: "Plan v2", base_rev: 1 });
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent).toEqual({ id, url: `https://fmrl.test/${id}#p=${key}`, rev: 2 });
    const put = puts().at(-1)!;
    const body = put.body as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["base_rev", "content", "encrypted", "format"]);
    expect(body).toMatchObject({ encrypted: true, format: "html", base_rev: 1 });
    const html = await openEnvelope(body.content as string, { key });
    expect(html).toContain("<h1>Plan v2</h1>");
    expect(html).toContain("<title>Plan v2</title>");
    // The key stays here; the token is remembered because the edit worked.
    expect(JSON.stringify(fake.requests)).not.toContain(key);
    expect(await b.pages.get(id)).toEqual({ key, manage: manageTok(manage_url) });

    const got = await call("fmrl_get", { id: url });
    expect(got.structuredContent).toMatchObject({ rev: 2, latest_rev: 2 });
    expect((got.structuredContent as { content: string }).content).toContain("<h1>Plan v2</h1>");
  });
  it("the owner edits its own private page through its ring, without a manage token and without sealed", async () => {
    const priv = await call("fmrl_publish", { content: "# Mine", private: true });
    const { id, url, manage_url } = priv.structuredContent as { id: string; url: string; manage_url: string };
    // Forget the key publishing remembered, keeping its manage token: the ring opens the page, and the owner has no use for the token.
    await writeFile(pagesFile, JSON.stringify({ version: 1, pages: { [fake.baseUrl]: { [id]: { manage: manageTok(manage_url) } } } }));
    const r = await call("fmrl_edit", { id, content: "# Mine, again", base_rev: 1 });
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent).toEqual({ id, url, rev: 2 });
    const put = puts().at(-1)!;
    expect(put.manageToken).toBeUndefined();
    expect(put.body).not.toHaveProperty("sealed");
    expect(await openEnvelope((put.body as { content: string }).content, { key: url.split("#p=")[1] })).toContain("<h1>Mine, again</h1>");
  });
  it("a private page with no key here fails with the sentence, and nothing is sent", async () => {
    const priv = await call("fmrl_publish", { content: "# Sealed", private: true });
    const { id, manage_url } = priv.structuredContent as { id: string; manage_url: string };
    const b = await second();
    const r = await b.call("fmrl_edit", { id: manage_url, content: "# Mine now" });
    expect(r.isError).toBe(true);
    expect(text(r)).toBe(PRIVATE_NEEDS_KEY);
    expect(puts()).toHaveLength(0);
    expect(await b.pages.get(id)).toEqual({});
  });
  it("a stale base_rev fails naming the latest revision", async () => {
    const pub = await call("fmrl_publish", { content: "# One", format: "md" });
    const id = (pub.structuredContent as { id: string }).id;
    await call("fmrl_edit", { id, content: "# Two", base_rev: 1 });
    const r = await call("fmrl_edit", { id, content: "# Also two", base_rev: 1 });
    expect(r.isError).toBe(true);
    expect(text(r)).toBe("Revision 2 is the latest; read it with fmrl_get and edit from there.");
    expect(r.structuredContent).toMatchObject({ latest_rev: 2 });
  });
  it("no edit ever sends sealed", async () => {
    const priv = await call("fmrl_publish", { content: "# S", private: true });
    const { id, url } = priv.structuredContent as { id: string; url: string };
    await call("fmrl_edit", { id: url, content: "# S2" });
    const pub = await call("fmrl_publish", { content: "# P" });
    await call("fmrl_edit", { id: (pub.structuredContent as { id: string }).id, content: "# P2" });
    expect(puts()).toHaveLength(2);
    for (const q of puts()) expect(q.body).not.toHaveProperty("sealed");
  });
  it("refuses blank content before any request", async () => {
    const pub = await call("fmrl_publish", { content: "# One" });
    const id = (pub.structuredContent as { id: string }).id;
    const r = await call("fmrl_edit", { id, content: "   " });
    expect(r.isError).toBe(true);
    expect(puts()).toHaveLength(0);
  });
  it("a conflicting private edit leaves the watched page in the inbox at the revisions it hasn't read", async () => {
    // The owner publishes (auto-watched at rev 1); another key revises past
    // its base_rev; the owner's stale edit conflicts. seen_rev must not have
    // advanced past base_rev, so the page stays in the owner's inbox.
    const priv = await call("fmrl_publish", { content: "# Plan\n\nv1", private: true });
    const { id, url, manage_url } = priv.structuredContent as { id: string; url: string; manage_url: string };
    const key = url.split("#p=")[1];
    const b = await agent({ file: "b2", agentName: "Bee" });
    const bEdit = await b.call("fmrl_edit", { id: `${manage_url}&p=${key}`, content: "# Plan\n\nv2 by B", base_rev: 1 });
    expect(bEdit.isError).toBeFalsy();

    const conflict = await call("fmrl_edit", { id: url, content: "# Plan\n\nv2 by owner", base_rev: 1 });
    expect(conflict.isError).toBe(true);
    expect(conflict.structuredContent).toMatchObject({ id, latest_rev: 2 });

    const inbox = await call("fmrl_inbox");
    const items = (inbox.structuredContent as { items: Array<Record<string, unknown>> }).items;
    expect(items).toMatchObject([{ id, rev: 2, seen_rev: 1 }]);
    expect((items[0].revisions as Array<{ rev: number }>).map((r) => r.rev)).toEqual([2]);
  });
  it("a private edit that renders to nothing is refused as nothing to save", async () => {
    const priv = await call("fmrl_publish", { content: "# S", private: true });
    const { url } = priv.structuredContent as { url: string };
    const r = await call("fmrl_edit", { id: url, content: "[ref]: https://example.com", format: "md" });
    expect(r.isError).toBe(true);
    expect(text(r)).toBe("Nothing to save: the content rendered to an empty page.");
    expect(puts()).toHaveLength(0);
  });
  it("the owner never sends a manage token, even one its link carries, and stores none", async () => {
    const pub = await call("fmrl_publish", { content: "# Mine", format: "md" });
    const { id, manage_url } = pub.structuredContent as { id: string; manage_url: string };
    await writeFile(pagesFile, JSON.stringify({ version: 1, pages: {} }));
    const r = await call("fmrl_edit", { id: manage_url, content: "# Mine, again", base_rev: 1 });
    expect(r.isError).toBeFalsy();
    expect(puts().at(-1)?.manageToken).toBeUndefined();
    expect(await pagesAt().get(id)).toEqual({});
  });
  it("GET /docs/{id} says whether the caller owns the page", async () => {
    const pub = await call("fmrl_publish", { content: "# Owned" });
    const id = (pub.structuredContent as { id: string }).id;
    const a = new FmrlApi(fake.baseUrl);
    expect((await a.get(keyOf(firstPublish()), id)).owned).toBe(true);
    const b = new FmrlApi(fake.baseUrl);
    const other = (await b.mint("other")).key;
    expect((await b.get(other, id)).owned).toBe(false);
    expect((await a.list(keyOf(firstPublish()))).docs.every((d) => d.owned === true)).toBe(true);
  });
  it("a refused link token falls back once to the stored one, which stays stored", async () => {
    const pub = await call("fmrl_publish", { content: "# Shared", format: "md" });
    const { id, manage_url } = pub.structuredContent as { id: string; manage_url: string };
    const b = await second();
    await b.pages.remember(id, { manage: manageTok(manage_url) });
    const forged = "f".repeat(22);
    const r = await b.call("fmrl_edit", { id: `https://fmrl.test/manage/${id}#k=${forged}`, content: "# By B", base_rev: 1 });
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent).toMatchObject({ rev: 2 });
    expect(puts().map((q) => q.manageToken)).toEqual([forged, manageTok(manage_url)]);
    expect(await b.pages.get(id)).toEqual({ manage: manageTok(manage_url) });
  });
  it("a refused link token with no other stored token fails with the manage-link hint, once", async () => {
    const pub = await call("fmrl_publish", { content: "# Shared", format: "md" });
    const { id } = pub.structuredContent as { id: string };
    const b = await second();
    const r = await b.call("fmrl_edit", { id: `https://fmrl.test/manage/${id}#k=${"f".repeat(22)}`, content: "# By B" });
    expect(r.isError).toBe(true);
    expect(text(r)).toBe(`You can edit this page with its manage link (https://fmrl.test/manage/${id}#k=…); pass it as id once and it is remembered.`);
    expect(puts()).toHaveLength(1);
    expect(await b.pages.get(id)).toEqual({});
  });
  it("a link token the server accepts replaces a stale stored one", async () => {
    const pub = await call("fmrl_publish", { content: "# Shared", format: "md" });
    const { id, manage_url } = pub.structuredContent as { id: string; manage_url: string };
    const b = await second();
    await b.pages.remember(id, { manage: "s".repeat(22) });
    const r = await b.call("fmrl_edit", { id: manage_url, content: "# By B" });
    expect(r.isError).toBeFalsy();
    expect(puts().map((q) => q.manageToken)).toEqual([manageTok(manage_url)]);
    expect(await b.pages.get(id)).toEqual({ manage: manageTok(manage_url) });
  });
});

/** agent is another MCP client on the same fake API: its own key file, page store, name and client name. */
const agent = async (opts: { file: string; agentName?: string; clientName?: string; apiKey?: string; api?: FmrlApi; log?: (l: string) => void }) => {
  const api = opts.api ?? new FmrlApi(fake.baseUrl);
  const keys = new KeyStore({ api, baseUrl: fake.baseUrl, apiKeyFromEnv: opts.apiKey, file: path.join(dir, `credentials-${opts.file}.json`) });
  const pages = new PageStore(fake.baseUrl, path.join(dir, `pages-${opts.file}.json`));
  const c = await connect({ api, keys, pages, agentName: opts.agentName, log: opts.log }, opts.clientName);
  return { call: async (name: string, args: Record<string, unknown> = {}) => (await c.callTool({ name, arguments: args })) as ToolResult, pages };
};
/** plantKey is a key the fake knows, with the label given, for an agent to use as FMRL_API_KEY. */
const plantKey = (label: string) => {
  const k = `fmrl_${"k".repeat(40)}${Math.random().toString(36).slice(2, 8)}`;
  fake.keys.add(k);
  fake.labels.set(k, label);
  return k;
};
const patches = () => fake.requests.filter((q) => q.method === "PATCH" && q.path === "/api/v1/me");

describe("fmrl_watch and fmrl_inbox", () => {
  it("describe the tools as the brief words them", async () => {
    const tools = (await client.listTools()).tools;
    expect(tools.find((t) => t.name === "fmrl_watch")!.description).toBe("Watch a page so revisions other editors make show up in fmrl_inbox. Pass the link you were handed; its key stays on this machine. Pages you publish are watched already.");
    expect(tools.find((t) => t.name === "fmrl_inbox")!.description).toBe("Pages you watch that someone else has revised since you last read them, newest first. Read each with fmrl_get (which marks it seen). A page that was removed or expired appears once.");
  });
  it("watching through a link with #p= remembers the key once it opens the page, and says it can open it", async () => {
    const priv = await call("fmrl_publish", { content: "# Plan", private: true });
    const { id, url } = priv.structuredContent as { id: string; url: string };
    const key = url.split("#p=")[1];
    const b = await agent({ file: "b" });
    const r = await b.call("fmrl_watch", { id: url });
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent).toEqual({ id, url, private: true, rev: 1, seen_rev: 1, can_open: true });
    expect(await b.pages.get(id)).toEqual({ key });
    expect(JSON.stringify(fake.requests)).not.toContain(key);
    expect(fake.requests.filter((q) => q.method === "PUT")).toMatchObject([{ path: `/api/v1/docs/${id}/watch`, body: undefined }]);
  });
  it("proving a private page's key does not mark its revisions seen", async () => {
    const priv = await call("fmrl_publish", { content: "# Plan", private: true });
    const { id, url } = priv.structuredContent as { id: string; url: string };
    const b = await agent({ file: "b" });
    const r = await b.call("fmrl_watch", { id: url, seen_rev: 0 });
    expect(r.structuredContent).toMatchObject({ rev: 1, seen_rev: 0, can_open: true });
    const inbox = await b.call("fmrl_inbox");
    expect((inbox.structuredContent as { items: unknown[] }).items).toMatchObject([{ id, rev: 1, seen_rev: 0, can_open: true }]);
  });
  it("a crafted #p= that opens nothing is not remembered, and the watch says it can't open the page", async () => {
    const priv = await call("fmrl_publish", { content: "# Plan", private: true });
    const { id } = priv.structuredContent as { id: string };
    const b = await agent({ file: "b" });
    const r = await b.call("fmrl_watch", { id: `https://fmrl.test/${id}#p=${"A".repeat(43)}`, seen_rev: 0 });
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent).toMatchObject({ id, private: true, seen_rev: 0, can_open: false });
    expect(await b.pages.get(id)).toEqual({});
  });
  it("the inbox lists another key's revision by its name, can_open, and fmrl_get of it empties the inbox", async () => {
    const pub = await call("fmrl_publish", { content: "# Shared", format: "md" });
    const { id, url, manage_url } = pub.structuredContent as { id: string; url: string; manage_url: string };
    const b = await agent({ file: "b", agentName: "Bee" });
    const edit = await b.call("fmrl_edit", { id: manage_url, content: "# Shared, by B", base_rev: 1 });
    expect(edit.isError).toBeFalsy();

    const inbox = await call("fmrl_inbox");
    expect(inbox.isError).toBeFalsy();
    const items = (inbox.structuredContent as { items: Array<Record<string, unknown>> }).items;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ id, url, private: false, status: "live", rev: 2, seen_rev: 1, can_open: true });
    expect(items[0].revisions).toMatchObject([{ rev: 2, editor: { kind: "key", name: "Bee" } }]);
    expect(text(inbox)).toContain(id);
    expect(text(inbox)).toContain("live");
    expect(text(inbox)).toContain("rev 2 by Bee");
    expect(text(inbox)).toContain(`read with fmrl_get ${url} rev 2`);

    await call("fmrl_get", { id, rev: 2 });
    const after = await call("fmrl_inbox");
    expect((after.structuredContent as { items: unknown[] }).items).toEqual([]);
  });
  it("a private page in the inbox can be opened only when its key is in the page store", async () => {
    const priv = await call("fmrl_publish", { content: "# Plan", private: true });
    const { id, url, manage_url } = priv.structuredContent as { id: string; url: string; manage_url: string };
    const b = await agent({ file: "b" });
    await b.call("fmrl_edit", { id: `${manage_url}&p=${url.split("#p=")[1]}`, content: "# Plan v2", base_rev: 1 });
    const edited = await b.call("fmrl_watch", { id: url });
    expect(edited.structuredContent).toMatchObject({ can_open: true });
    const mine = await call("fmrl_inbox");
    expect((mine.structuredContent as { items: Array<{ can_open: boolean }> }).items).toMatchObject([{ id, can_open: true }]);
    await writeFile(pagesFile, JSON.stringify({ version: 1, pages: {} }));
    const forgotten = await call("fmrl_inbox");
    expect((forgotten.structuredContent as { items: Array<{ can_open: boolean }> }).items).toMatchObject([{ id, can_open: false }]);
  });
  it("an empty inbox says so", async () => {
    const r = await call("fmrl_inbox");
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent).toEqual({ items: [] });
    expect(text(r)).toMatch(/^Nothing new/);
  });
});

describe("the key's name", () => {
  it("FMRL_AGENT_NAME names the key on the first call, replacing a different name, once per process", async () => {
    const b = await agent({ file: "b", agentName: "Bee" });
    const who = await b.call("fmrl_whoami");
    expect(who.isError).toBeFalsy();
    expect(patches()).toHaveLength(1);
    expect(patches()[0].body).toEqual({ label: "Bee" });
    expect(who.structuredContent).toMatchObject({ label: "Bee" });
    expect(text(who)).toContain("Bee");
    await b.call("fmrl_whoami");
    expect(patches()).toHaveLength(1);
    expect(fake.requests.filter((q) => q.path === "/api/v1/me" && q.method === "GET")).toHaveLength(3);
  });
  it("FMRL_AGENT_NAME equal to the name already set sends nothing", async () => {
    const k = plantKey("Bee");
    const b = await agent({ file: "b", agentName: "Bee", apiKey: k });
    await b.call("fmrl_whoami");
    expect(patches()).toHaveLength(0);
  });
  it("the MCP client's name fills an empty name", async () => {
    const k = plantKey("");
    const b = await agent({ file: "b", clientName: "claude-code", apiKey: k });
    await b.call("fmrl_list");
    expect(patches().map((q) => q.body)).toEqual([{ label: "claude-code" }]);
    expect(fake.labels.get(k)).toBe("claude-code");
  });
  it("the MCP client's name fills the name a minted key starts with", async () => {
    const k = plantKey("fmrl-mcp");
    const b = await agent({ file: "b", clientName: "claude-code", apiKey: k });
    await b.call("fmrl_list");
    expect(patches().map((q) => q.body)).toEqual([{ label: "claude-code" }]);
    expect(fake.labels.get(k)).toBe("claude-code");
  });
  it("a key this plugin mints takes the MCP client's name on its first call", async () => {
    const b = await agent({ file: "b", clientName: "claude-code" });
    await b.call("fmrl_whoami");
    expect(patches().map((q) => q.body)).toEqual([{ label: "claude-code" }]);
  });
  it("the MCP client's name never replaces a name already set", async () => {
    const k = plantKey("Existing");
    const b = await agent({ file: "b", clientName: "claude-code", apiKey: k });
    await b.call("fmrl_list");
    expect(patches()).toHaveLength(0);
    expect(fake.labels.get(k)).toBe("Existing");
  });
  it("a name that can't be set costs one log line, never the tool call", async () => {
    const lines: string[] = [];
    const api = new FmrlApi(fake.baseUrl);
    api.setLabel = async () => { throw new Error("PATCH refused"); };
    const b = await agent({ file: "b", agentName: "Bee", api, log: (l) => lines.push(l) });
    const r = await b.call("fmrl_publish", { content: "# Still published" });
    expect(r.isError).toBeFalsy();
    expect(lines.filter((l) => l.includes("PATCH refused"))).toHaveLength(1);
  });
});

describe("plugin freshness", () => {
  const [major, minor] = VERSION.split(".");
  /** root is a fake CLAUDE_PLUGIN_ROOT whose manifest carries version. */
  const root = async (version: string): Promise<string> => {
    const r = await mkdtemp(path.join(tmpdir(), "fmrl-plugin-"));
    await mkdir(path.join(r, ".claude-plugin"));
    await writeFile(path.join(r, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "fmrl", version }));
    return r;
  };
  const withRoot = async (pluginRoot: string | undefined, fn: (c: Client) => Promise<void>) => {
    const api = new FmrlApi(fake.baseUrl);
    const keys = new KeyStore({ api, baseUrl: fake.baseUrl, file: path.join(dir, "plugin-creds.json") });
    const c = await connect({ api, keys, pluginRoot });
    try { await fn(c); } finally { await c.close(); }
  };
  const whoami = async (c: Client) => text((await c.callTool({ name: "fmrl_whoami", arguments: {} })) as ToolResult);

  it("a stale plugin: the instructions raise it and fmrl_whoami says how to fix it", async () => {
    await withRoot(await root("0.3.0"), async (c) => {
      const instructions = c.getInstructions() ?? "";
      expect(instructions).toContain(`installed 0.3, fmrl-mcp is at ${major}.${minor}`);
      expect(instructions).toContain("claude plugin update fmrl@fmrl-plugin");
      expect(await whoami(c)).toContain(`The fmrl plugin is out of date: installed 0.3, fmrl-mcp is at ${major}.${minor}.`);
    });
  });
  it("a plugin a patch behind: no instructions, and fmrl_whoami says it is up to date", async () => {
    await withRoot(await root(`${major}.${minor}.0`), async (c) => {
      expect(c.getInstructions()).toBeUndefined();
      expect(await whoami(c)).toContain(`The fmrl plugin is up to date (plugin ${major}.${minor}.0, fmrl-mcp ${VERSION}).`);
    });
  });
  it("no CLAUDE_PLUGIN_ROOT: no instructions and no plugin line", async () => {
    await withRoot(undefined, async (c) => {
      expect(c.getInstructions()).toBeUndefined();
      expect(await whoami(c)).not.toContain("fmrl plugin");
    });
  });
  it("a malformed plugin.json: no instructions and no plugin line", async () => {
    const r = await mkdtemp(path.join(tmpdir(), "fmrl-plugin-"));
    await mkdir(path.join(r, ".claude-plugin"));
    await writeFile(path.join(r, ".claude-plugin", "plugin.json"), "{ not json");
    await withRoot(r, async (c) => {
      expect(c.getInstructions()).toBeUndefined();
      expect(await whoami(c)).not.toContain("fmrl plugin");
    });
  });
  it("the other tools' results are unchanged by a stale plugin", async () => {
    await withRoot(await root("0.3.0"), async (c) => {
      const r = (await c.callTool({ name: "fmrl_publish", arguments: { content: "# hi" } })) as ToolResult;
      expect(text(r)).not.toContain("plugin");
    });
  });
});
