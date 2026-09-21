import type { Stats } from "node:fs";
import { mkdtemp, unlink, writeFile } from "node:fs/promises";
import os, { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FmrlApi } from "../src/api.js";
import { readCredentials, writeCredentials } from "../src/credentials.js";
import { newRing, openEnvelope, openRecord, sealRecord } from "../src/crypto.js";
import { MAX_BYTES } from "../src/format.js";
import { KeyStore } from "../src/keys.js";
import { createServer, LIST_EMPTY, NOT_HELD_LINE, RING_ENV_LINE, RING_FILE_LINE, SEVEN_DAYS_PRIVATE, type ServerDeps } from "../src/server.js";
import { startFakeApi, type FakeApi } from "./fake-api.js";

let fake: FakeApi; let client: Client; let dir: string; let credFile: string;
type ToolResult = { content: Array<{ type: string; text?: string }>; structuredContent?: Record<string, unknown>; isError?: boolean };
const call = async (name: string, args: Record<string, unknown> = {}): Promise<ToolResult> => (await client.callTool({ name, arguments: args })) as ToolResult;
const text = (r: ToolResult) => r.content.map((c) => c.text ?? "").join("\n");
const ringInFile = async () => (await readCredentials(credFile)).keys[fake.baseUrl]?.ring;
// The browser's #r= grammar (static/fmrl.js ringsFromFragment).
const RING_PAIR = /#r=([A-Za-z0-9_]{1,16})\.([A-Za-z0-9_-]{43})$/;
const keyOf = (q: { auth?: string }) => (q.auth as string).slice("Bearer ".length);
const connect = async (deps: ServerDeps): Promise<Client> => {
  const s = createServer(deps);
  const [c, t] = InMemoryTransport.createLinkedPair();
  await s.connect(t);
  const cl = new Client({ name: "extra", version: "0" });
  await cl.connect(c);
  return cl;
};

beforeEach(async () => {
  fake = await startFakeApi();
  dir = await mkdtemp(path.join(tmpdir(), "fmrl-"));
  credFile = path.join(dir, "credentials.json");
  const api = new FmrlApi(fake.baseUrl);
  const keys = new KeyStore({ api, baseUrl: fake.baseUrl, file: credFile });
  const server = createServer({ api, keys });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  client = new Client({ name: "test", version: "0" });
  await client.connect(ct);
});
afterEach(async () => { await client.close(); await fake.close(); });

describe("tools", () => {
  it("lists exactly the six tools", async () => {
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual(["fmrl_delete", "fmrl_get", "fmrl_list", "fmrl_publish", "fmrl_publish_file", "fmrl_whoami"]);
  });
  it("fmrl_publish mints a key on first use and returns url, expiry, the seven-days line and the manage link", async () => {
    const r = await call("fmrl_publish", { content: "# Hello", title: "Hello" });
    expect(r.isError).toBeFalsy();
    const t = text(r);
    const id = (r.structuredContent as { id: string }).id;
    const prefix = keyOf(fake.requests[1]).slice(0, 9);
    const ring = await ringInFile();
    expect(ring).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(t.split("\n")).toEqual([
      `Published: https://fmrl.test/${id}`,
      "Expires 2026-09-15T12:00:00Z",
      "This page lasts seven days unless someone keeps it on the page itself.",
      `Manage link (removes the page; give it only to someone who should be able to): https://fmrl.test/manage/${id}#k=tok${id}`,
      `See your pages on fmrl.site: open https://fmrl.test/link/code${id}#r=${prefix}.${ring} once in your browser (it works for an hour, and once). It also carries the ring that lets that browser open your private pages.`,
    ]);
    expect(r.structuredContent).toMatchObject({ id, url: `https://fmrl.test/${id}`, status: "live" });
    expect(r.structuredContent).toMatchObject({ link_url: `https://fmrl.test/link/code${id}#r=${prefix}.${ring}` });
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
  it("fmrl_publish private: seals the page's key and title under the ring, and the link carries that ring", async () => {
    const r = await call("fmrl_publish", { content: "# Quiet\n\nhello", private: true });
    expect(r.isError).toBeFalsy();
    const body = fake.requests[1].body as { sealed?: string };
    const pageKey = /#p=([A-Za-z0-9_-]{43})$/.exec((r.structuredContent as { url: string }).url)![1];
    const ring = (await ringInFile())!;
    expect(await openRecord(ring, body.sealed!)).toEqual({ key: pageKey, title: "Quiet" });
    const pair = RING_PAIR.exec((r.structuredContent as { link_url: string }).link_url)!;
    expect(pair[1]).toBe(keyOf(fake.requests[1]).slice(0, 9));
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
    const [first, second, extra] = text(got).split("\n");
    expect(first.startsWith(`Quiet — ${url}: live, html, `)).toBe(true);
    expect(first.endsWith(" bytes, expires 2026-09-15T12:00:00Z.")).toBe(true);
    expect(second).toBe(SEVEN_DAYS_PRIVATE);
    expect(extra).toBeUndefined();
    expect(got.structuredContent).toMatchObject({ id, url, private: true, key_held: true, title: "Quiet" });
    expect(got.structuredContent).not.toHaveProperty("sealed");
  });
  it("fmrl_get says a private page's key is not held here when another key owns it", async () => {
    const priv = await call("fmrl_publish", { content: "# Theirs", private: true });
    const id = (priv.structuredContent as { id: string }).id;
    fake.docs.get(id)!.owner = "fmrl_" + "Z".repeat(32);
    const got = await call("fmrl_get", { id });
    expect(got.isError).toBeFalsy();
    expect(text(got)).toContain(NOT_HELD_LINE);
    expect(text(got)).toContain(SEVEN_DAYS_PRIVATE);
    expect(got.structuredContent).toMatchObject({ id, url: `https://fmrl.test/${id}`, private: true, key_held: false });
  });
});
