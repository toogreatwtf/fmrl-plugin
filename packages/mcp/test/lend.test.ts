import { readFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApiError, FmrlApi } from "../src/api.js";
import { writeCredentials } from "../src/credentials.js";
import { newRing, seal, sealRecord } from "../src/crypto.js";
import { KeyStore } from "../src/keys.js";
import { LentRings, Lender } from "../src/lent.js";
import { PageStore } from "../src/pages.js";
import { createServer } from "../src/server.js";
import { startFakeApi, type FakeApi } from "./fake-api.js";

type ToolResult = { content: Array<{ type: string; text?: string }>; structuredContent?: Record<string, unknown>; isError?: boolean };
const vaultFx = JSON.parse(readFileSync(new URL("./fixtures/vault.json", import.meta.url), "utf8")) as { pub: string; fingerprint: string };
const PERSON = "fmrl_" + "P".repeat(32);

let fake: FakeApi; let dir: string; let client: Client; let agentKey: string; let agentRing: string;
const call = async (name: string, args: Record<string, unknown> = {}): Promise<ToolResult> => (await client.callTool({ name, arguments: args })) as ToolResult;
const text = (r: ToolResult) => r.content.map((c) => c.text ?? "").join("\n");
const lendPosts = () => fake.requests.filter((q) => q.method === "POST" && q.path === "/api/v1/me/lend").length;

/** connect starts a server on an agent key with its own ring, attached to a person with private pages turned on and its ring already in their account. */
const connect = async (opts: { attached?: boolean; ringUploaded?: boolean } = {}) => {
  const api = new FmrlApi(fake.baseUrl);
  const minted = await api.mint("agent");
  agentKey = minted.key; agentRing = newRing();
  const file = path.join(dir, "credentials.json");
  await writeCredentials(file, { version: 1, keys: { [fake.baseUrl]: { ...minted, ring: agentRing } } });
  if (opts.attached !== false) {
    fake.linked.add(agentKey);
    fake.accountVaults.set(agentKey, { pub: vaultFx.pub, fingerprint: vaultFx.fingerprint });
    if (opts.ringUploaded !== false) fake.ringBoxes.set(fake.prefixOf(agentKey), "uploaded");
  }
  const keys = new KeyStore({ api, baseUrl: fake.baseUrl, file });
  const server = createServer({ api, keys, pages: new PageStore(fake.baseUrl, path.join(dir, "pages.json")), lendWait: { intervalMs: 5, timeoutMs: 200 } });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  client = new Client({ name: "test", version: "0" });
  await client.connect(ct);
};

/** personPage plants a private page the person owns, its record sealed under their ring, which the server names to the agent. */
const personPage = async (id: string, html: string, personRing: string, ringId = "pring1", readers = new Set([agentKey])) => {
  const { envelope, key } = await seal(html);
  fake.docs.set(id, {
    id, owner: PERSON, format: "html", size: envelope.length, encrypted: true, sealed: await sealRecord(personRing, key, "Theirs"), ring: ringId, readers, rev: 1,
    revisions: [{ rev: 1, at: "2026-09-08T12:00:00.000Z", size: envelope.length, sha256: "x", title: "", source: "browser", format: "html", content: envelope, editor: { kind: "session" } }],
  });
};
/** lend plays the person's browser: it seals their ring under the agent's ring and marks the link used. */
const lend = async (personRing: string, ringId = "pring1") => {
  fake.lentRings.set(agentKey, [{ ring: ringId, box: await sealRecord(agentRing, personRing, ringId) }]);
  fake.lendAnswer(agentKey, "lent");
};

beforeEach(async () => {
  fake = await startFakeApi();
  dir = await mkdtemp(path.join(tmpdir(), "fmrl-lend-"));
  process.env.FMRL_FILES_DIR = path.join(dir, "files");
});
afterEach(async () => { await client?.close(); await fake.close(); });

describe("fmrl_get on the person's private pages", () => {
  it("hands back a lend link when the page doesn't open, then reads it once the person lent their rings", async () => {
    await connect();
    const ring = newRing();
    await personPage("aaaaaaaaaaaa", "<h1>Plans</h1>", ring);
    const first = await call("fmrl_get", { id: "aaaaaaaaaaaa" });
    expect(first.isError).toBeFalsy();
    const url = first.structuredContent?.lend_url as string;
    expect(url).toMatch(/^https:\/\/fmrl\.test\/lend\//);
    expect(first.structuredContent?.lend_expires_at).toEqual(expect.any(String));
    expect(first.structuredContent?.content).toBeUndefined();
    expect(text(first)).toContain(url);
    expect(text(first)).toContain("Never open the link yourself");

    // A second read while the link is live hands out the same link, without minting another.
    const again = await call("fmrl_get", { id: "aaaaaaaaaaaa" });
    expect(again.structuredContent?.lend_url).toBe(url);
    expect(lendPosts()).toBe(1);

    await lend(ring);
    const waited = await call("fmrl_lend", { wait: true });
    expect(waited.structuredContent).toMatchObject({ status: "lent" });
    const read = await call("fmrl_get", { id: "aaaaaaaaaaaa" });
    expect(read.structuredContent?.content).toContain("Plans");
    expect(read.structuredContent?.lend_url).toBeUndefined();
  });

  it("reads a page lent before this process started, without asking", async () => {
    const ring = newRing();
    await connect();
    await personPage("bbbbbbbbbbbb", "<p>Already</p>", ring);
    await lend(ring);
    const r = await call("fmrl_get", { id: "bbbbbbbbbbbb" });
    expect(r.structuredContent?.content).toContain("Already");
    expect(lendPosts()).toBe(0);
  });

  it("re-reads the lend when the person lent after this process last looked", async () => {
    const ring = newRing();
    await connect();
    await personPage("cccccccccccc", "<p>Fresh</p>", ring);
    await call("fmrl_list"); // reads (and keeps) an empty lend
    await lend(ring);
    const r = await call("fmrl_get", { id: "cccccccccccc" });
    expect(r.structuredContent?.content).toContain("Fresh");
  });

  it("doesn't ask again after the person chose Not now", async () => {
    await connect();
    await personPage("dddddddddddd", "<p>x</p>", newRing());
    fake.lendAnswer(agentKey, "declined");
    const r = await call("fmrl_get", { id: "dddddddddddd" });
    expect(r.structuredContent?.lend_url).toBeUndefined();
    expect(text(r)).toContain("chose Not now");
    expect(lendPosts()).toBe(0);
  });

  it("after a lend, asks again only for a page among the person's own", async () => {
    const ring = newRing();
    await connect();
    await personPage("eeeeeeeeeeee", "<p>Mine</p>", ring);
    await lend(ring);
    // Someone else's private page, not shared with the person: a new lend wouldn't open it.
    await personPage("ffffffffffff", "<p>Stranger</p>", newRing(), "other", new Set());
    const stranger = await call("fmrl_get", { id: "ffffffffffff" });
    expect(stranger.structuredContent?.lend_url).toBeUndefined();
    expect(lendPosts()).toBe(0);
    // A page shared with the person since the lend: ask again.
    await personPage("gggggggggggg", "<p>New</p>", newRing(), "pring2");
    const shared = await call("fmrl_get", { id: "gggggggggggg" });
    expect(shared.structuredContent?.lend_url).toEqual(expect.any(String));
  });

  it("sends the agent's ring to the person's account first when it isn't there yet", async () => {
    await connect({ ringUploaded: false });
    await personPage("hhhhhhhhhhhh", "<p>x</p>", newRing());
    const r = await call("fmrl_get", { id: "hhhhhhhhhhhh" });
    expect(fake.requests.some((q) => q.method === "PUT" && q.path === "/api/v1/me/rings")).toBe(true);
    expect(r.structuredContent?.lend_url).toEqual(expect.any(String));
    expect(lendPosts()).toBe(2);
  });

  it("passes on why no link could be made", async () => {
    await connect();
    await personPage("nnnnnnnnnnnn", "<p>x</p>", newRing());
    fake.accountVaults.set(agentKey, null);
    const r = await call("fmrl_get", { id: "nnnnnnnnnnnn" });
    expect(r.isError, text(r)).toBeFalsy();
    expect(r.structuredContent?.lend_url).toBeUndefined();
    expect(text(r)).toContain("turn on private pages");
  });

  it("keeps the plain private note for an agent attached to no one, or a server without lending", async () => {
    await connect({ attached: false });
    await personPage("jjjjjjjjjjjj", "<p>x</p>", newRing(), "pring1", new Set());
    const r = await call("fmrl_get", { id: "jjjjjjjjjjjj" });
    expect(r.structuredContent?.lend_url).toBeUndefined();
    expect(text(r)).toContain("#p=");
    expect(lendPosts()).toBe(0);
    await client.close();
    fake.noLend = true;
    await connect();
    await personPage("kkkkkkkkkkkk", "<p>x</p>", newRing());
    const old = await call("fmrl_get", { id: "kkkkkkkkkkkk" });
    expect(old.structuredContent?.lend_url).toBeUndefined();
    expect(old.isError).toBeFalsy();
  });

  it("fmrl_list opens the person's private pages with lent rings", async () => {
    const ring = newRing();
    await connect();
    await personPage("llllllllllll", "<p>x</p>", ring);
    await lend(ring);
    const r = await call("fmrl_list");
    const row = (r.structuredContent?.docs as Array<{ id: string; title?: string; url: string }>).find((d) => d.id === "llllllllllll")!;
    expect(row.title).toBe("Theirs");
    expect(row.url).toContain("#p=");
  });

  it("fmrl_edit on a person's page it can't open points at fmrl_get", async () => {
    await connect();
    await personPage("mmmmmmmmmmmm", "<p>x</p>", newRing());
    const r = await call("fmrl_edit", { id: "mmmmmmmmmmmm", content: "<p>y</p>" });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("read it with fmrl_get first");
  });
});

describe("fmrl_lend", () => {
  it("makes a link, then waits for each answer", async () => {
    await connect();
    const r = await call("fmrl_lend");
    expect(r.structuredContent).toMatchObject({ status: "pending", lend_url: expect.stringMatching(/^https:\/\/fmrl\.test\/lend\//) });
    const pending = await call("fmrl_lend", { wait: true });
    expect(pending.structuredContent).toMatchObject({ status: "pending" });
    expect(text(pending)).toContain("hasn't answered yet");
    fake.lendAnswer(agentKey, "declined");
    expect(text(await call("fmrl_lend", { wait: true }))).toContain("chose Not now");
    fake.lendAnswer(agentKey, "expired");
    expect(text(await call("fmrl_lend", { wait: true }))).toContain("ran out");
  });

  it("makes a new link when asked even after Not now", async () => {
    await connect();
    fake.lendAnswer(agentKey, "declined");
    const r = await call("fmrl_lend");
    expect(r.structuredContent?.lend_url).toEqual(expect.any(String));
  });

  it("fails plainly for an agent attached to no one", async () => {
    await connect({ attached: false });
    const r = await call("fmrl_lend");
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("fmrl_attach");
    const w = await call("fmrl_lend", { wait: true });
    expect(w.isError).toBe(true);
  });
});

describe("LentRings and Lender", () => {
  const fakeApi = (over: Partial<Record<"lent" | "lend" | "lendState" | "me", (k: string) => Promise<unknown>>>) => over as unknown as FmrlApi;

  it("opens only boxes whose record names the ring they hold, and keeps them for a while", async () => {
    const own = newRing(); const lentRing = newRing();
    let reads = 0; let t = 0;
    const api = fakeApi({ lent: async () => { reads++; return { rings: [
      { ring: "good", box: await sealRecord(own, lentRing, "good") },
      { ring: "liar", box: await sealRecord(own, newRing(), "someone-else") },
      { ring: "foreign", box: await sealRecord(newRing(), newRing(), "foreign") },
      { ring: 5, box: null },
    ] }; } });
    const rings = new LentRings({ api, ownRings: async () => [own], now: () => t });
    expect([...(await rings.get("k")).entries()]).toEqual([["good", lentRing]]);
    await rings.get("k");
    expect(reads).toBe(1);
    t = 61_000;
    await rings.get("k");
    expect(reads).toBe(2);
    rings.forget("k");
    await rings.get("k");
    expect(reads).toBe(3);
  });

  it("treats 403 and 404 as nothing lent, and doesn't keep a failed read", async () => {
    let fail: ApiError | Error = new ApiError(403, "not_claimed", "");
    const api = fakeApi({ lent: async () => { throw fail; } });
    const rings = new LentRings({ api, ownRings: async () => [] });
    expect((await rings.get("k")).size).toBe(0);
    rings.forget("k");
    fail = new Error("network");
    await expect(rings.get("k")).rejects.toThrow("network");
    fail = new ApiError(404, "not_found", "");
    expect((await rings.get("k")).size).toBe(0);
  });

  it("puts the hinted ring first", async () => {
    const own = newRing(); const a = newRing(); const b = newRing();
    const api = fakeApi({ lent: async () => ({ rings: [{ ring: "a", box: await sealRecord(own, a, "a") }, { ring: "b", box: await sealRecord(own, b, "b") }] }) });
    const rings = new LentRings({ api, ownRings: async () => [own] });
    expect(await rings.ringsFor("k", "b")).toEqual([b, a]);
    expect(await rings.ringsFor("k", "missing")).toEqual([a, b]);
  });

  it("reuses a live link, mints anew near its end, and syncs the ring once on ring_missing", async () => {
    let t = 0; let mints = 0; let missing = 1; let syncs = 0;
    const api = fakeApi({
      lendState: async () => ({ status: "pending", lent: false }),
      lend: async () => {
        if (missing-- > 0) throw new ApiError(409, "ring_missing", "");
        mints++;
        return { url: `https://fmrl.test/lend/${mints}`, expires_at: new Date(600_000).toISOString() };
      },
    });
    const lender = new Lender({ api, syncRings: async () => { syncs++; return true; }, now: () => t });
    expect(await lender.ask("k")).toMatchObject({ kind: "link", url: "https://fmrl.test/lend/1" });
    expect(syncs).toBe(1);
    expect(await lender.ask("k")).toMatchObject({ url: "https://fmrl.test/lend/1" });
    t = 580_000;
    expect(await lender.ask("k")).toMatchObject({ url: "https://fmrl.test/lend/2" });
    missing = 2;
    lender.forget("k");
    expect(await lender.ask("k")).toEqual({ kind: "refused", code: "ring_missing", message: "" });
    expect(syncs).toBe(2);
  });

  it("asks nothing of the lend routes for an agent attached to no one", async () => {
    let states = 0;
    const api = { me: async () => ({ attached_at: null }), lendState: async () => { states++; return { status: "none", lent: false }; } } as unknown as FmrlApi;
    const lender = new Lender({ api, syncRings: async () => true });
    expect(await lender.state("k")).toBeUndefined();
    expect(states).toBe(0);
  });

  it("rethrows a revoked key and honours Not now unless forced", async () => {
    const api = fakeApi({
      lendState: async () => ({ status: "declined", lent: false }),
      lend: async () => { throw new ApiError(401, "key_revoked", ""); },
    });
    const lender = new Lender({ api, syncRings: async () => true });
    expect(await lender.ask("k")).toEqual({ kind: "declined" });
    await expect(lender.ask("k", { force: true })).rejects.toBeInstanceOf(ApiError);
  });
});
