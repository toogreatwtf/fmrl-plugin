import { execFileSync } from "node:child_process";
import { readFileSync, type Stats } from "node:fs";
import { createECDH } from "node:crypto";
import { chmod, link, mkdir, mkdtemp, open as fsOpen, readdir, readFile, realpath, rename, stat as statFile, symlink, unlink, writeFile } from "node:fs/promises";
import os, { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, FmrlApi } from "../src/api.js";
import { readCredentials, writeCredentials } from "../src/credentials.js";
import { newRing, openEnvelope, openRecord, seal, sealRecord } from "../src/crypto.js";
import { MAX_BYTES } from "../src/format.js";
import { KeyStore } from "../src/keys.js";
import { PageStore } from "../src/pages.js";
import { CONTENT_WRITTEN, createServer, machineName, EDIT_ONE_SOURCE, LIST_EMPTY, NO_OWN_FILE, NOT_HELD_LINE, NOT_OWN_FILE, OUTSIDE_FOLDER, RING_ENV_LINE, RING_FILE_LINE, SEVEN_DAYS_PRIVATE, VERSION, type ServerDeps } from "../src/server.js";
import { vaultFingerprint } from "../src/vault-crypto.js";
import { NO_PLUGIN_LINE, VERBOSE_HINT } from "../src/status.js";
import { PREFER_THIS_SERVER } from "../src/plugin.js";
import { hangingFetch, startFakeApi, type FakeApi } from "./fake-api.js";

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
const lastPublish = () => fake.requests.filter((q) => q.path === "/api/v1/publish").at(-1)!;
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
  // Every server in this file keeps to_file and content_file in the test's own folder, never ~/fmrl.
  process.env.FMRL_FILES_DIR = path.join(dir, "files");
  const api = new FmrlApi(fake.baseUrl);
  const keys = new KeyStore({ api, baseUrl: fake.baseUrl, file: credFile });
  const server = createServer({ api, keys, pages: pagesAt() });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  client = new Client({ name: "test", version: "0" });
  await client.connect(ct);
});
afterEach(async () => { await client.close(); await fake.close(); });


describe("account vault sync integration", () => {
  const fx = JSON.parse(readFileSync(new URL("./fixtures/vault.json", import.meta.url), "utf8")) as { pub: string; fingerprint: string; vault_key: string; private_pkcs8: string };
  const second = createECDH("prime256v1");
  second.generateKeys();
  const pub2 = second.getPublicKey().toString("base64url");
  const next = { pub: pub2, fingerprint: vaultFingerprint(pub2) };
  const synced = (f: string) => `Private page keys: synced to your fmrl account (vault ${f}).`;
  const firstPin = (f: string) => `First sync: pinned your account's vault ${f}. If /account shows a different fingerprint, tell me.`;
  const noVault = "Private page keys: not synced (this key isn't in an account, or the account hasn't turned on sync).";
  const changed = `Your account's vault fingerprint changed from ${fx.fingerprint} to ${next.fingerprint}, so I didn't send your key rings. If you reset private page sync on fmrl.site/account and it shows ${next.fingerprint}, ask me to trust it.`;
  const ringRequests = () => fake.requests.filter(q => q.path === "/api/v1/me/rings");
  const seed = async (vault = true) => {
    const minted = await new FmrlApi(fake.baseUrl).mint("test");
    await writeCredentials(credFile, { version: 1, keys: { [fake.baseUrl]: { ...minted, ring: newRing() } } });
    if (vault) fake.accountVaults.set(minted.key, { pub: fx.pub, fingerprint: fx.fingerprint });
    return minted.key;
  };
  const warm = async () => { await call("fmrl_list"); return fake.requests.length; };

  it.each(["environment-only", "different", "equal"])("whoami vault status reflects the actual %s environment ring", async mode => {
    const key = await seed();
    const saved = await readCredentials(credFile); const stored = saved.keys[fake.baseUrl].ring!;
    if (mode === "environment-only") { delete saved.keys[fake.baseUrl].ring; await writeCredentials(credFile, saved); }
    const api = new FmrlApi(fake.baseUrl);
    const keys = new KeyStore({ api, baseUrl: fake.baseUrl, file: credFile, ringFromEnv: mode === "equal" ? stored : newRing() });
    const c = await connect({ api, keys });
    try {
      const result = await c.callTool({ name: "fmrl_whoami", arguments: {} }) as ToolResult;
      expect(result.isError).not.toBe(true);
      expect(text(result)).toContain(RING_ENV_LINE);
      if (mode === "equal") expect(text(result)).toContain(synced(fx.fingerprint));
      else {
        expect(text(result)).not.toContain("Private page keys:");
        expect(fake.ringBatches).toEqual([]);
        expect(fake.ringBoxes.has(fake.prefixOf(key))).toBe(false);
      }
    } finally { await c.close(); }
  });
  it("whoami without an account vault uses the exact not-synced line", async () => {
    await seed(false);
    const r = await call("fmrl_whoami");
    expect(text(r)).toContain(noVault);
    expect(text(r)).not.toContain("Signing in does not back up private-page keys");
    expect(ringRequests()).toHaveLength(0);
  });
  it("whoami sync uses its fresh me, pins once and strips account_vault", async () => {
    await seed();
    const offset = await warm();
    const a = await call("fmrl_whoami");
    expect(text(a)).toContain(synced(fx.fingerprint));
    expect(text(a)).toContain(firstPin(fx.fingerprint));
    expect(a.structuredContent).not.toHaveProperty("account_vault");
    expect(text(a)).toContain(RING_FILE_LINE(credFile));
    expect(text(a)).not.toContain("Signing in does not back up private-page keys");
    const b = await call("fmrl_whoami");
    expect(text(b)).toContain(synced(fx.fingerprint));
    expect(text(b)).not.toContain(firstPin(fx.fingerprint));
    expect(fake.requests.slice(offset).map(q => [q.method, q.path])).toEqual([
      ["GET", "/api/v1/me"], ["PUT", "/api/v1/me/rings"],
      ["GET", "/api/v1/me"], ["PUT", "/api/v1/me/rings"],
    ]);
  });
  it("vault changes require exact trust and never automatically repin", async () => {
    const key = await seed();
    await call("fmrl_whoami");
    fake.accountVaults.set(key, next);
    const offset = ringRequests().length;
    const a = await call("fmrl_whoami");
    expect(text(a)).toContain(changed);
    expect(text(a)).not.toContain(synced(next.fingerprint));
    expect(ringRequests()).toHaveLength(offset);
    const wrong = await call("fmrl_whoami", { trust_vault: fx.fingerprint });
    expect(text(wrong)).not.toContain(synced(next.fingerprint));
    expect((await readCredentials(credFile)).vault_pins).toEqual({ [fake.baseUrl]: fx.fingerprint });
    expect(ringRequests()).toHaveLength(offset);
    const trusted = await call("fmrl_whoami", { trust_vault: next.fingerprint });
    expect(text(trusted)).toContain(synced(next.fingerprint));
    expect((await readCredentials(credFile)).vault_pins).toEqual({ [fake.baseUrl]: next.fingerprint });
    expect(ringRequests()).toHaveLength(offset + 1);
  });
  it("incorrect first trust never pins or uploads a vault", async () => {
    await seed();
    const tool = (await client.listTools()).tools.find(t => t.name === "fmrl_whoami")!;
    expect(tool.inputSchema.properties).toHaveProperty("trust_vault");
    const r = await call("fmrl_whoami", { trust_vault: next.fingerprint });
    expect(r.isError).toBeFalsy();
    expect(text(r)).not.toContain("Private page keys:");
    expect(text(r)).not.toContain("First sync:");
    expect((await readCredentials(credFile)).vault_pins).toBeUndefined();
    expect(ringRequests()).toHaveLength(0);
  });
  it.each([429, 500, 401])("vault sync %s preserves whoami success without a false status, and first pin appears once", async status => {
    await seed();
    fake.ringStatus = status;
    const r = await call("fmrl_whoami");
    expect(r.isError).toBeFalsy();
    expect(text(r)).not.toContain("Private page keys:");
    expect(text(r)).toContain(firstPin(fx.fingerprint));
    expect((r.structuredContent as { notes?: string[] }).notes).toContain(firstPin(fx.fingerprint));
    expect(text(await call("fmrl_whoami"))).not.toContain("First sync:");
    expect(fake.requests.filter(q => q.path === "/api/v1/keys")).toHaveLength(1);
    expect(ringRequests()).toHaveLength(2);
  });
  it("null account vault preserves primary whoami identity quota and link", async () => {
    const key = await seed(); fake.accountVaults.set(key, null);
    const r = await call("fmrl_whoami");
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent).toMatchObject({ prefix: fake.prefixOf(key), quota: { publishes: { used: 0 } }, attach_url: expect.any(String) });
    expect(r.structuredContent).not.toHaveProperty("account_vault");
    expect(text(r)).not.toContain("Private page keys:"); expect(ringRequests()).toHaveLength(0);
  });
  it("malformed vault is unknown and stripped from whoami output", async () => {
    const key = await seed();
    fake.accountVaults.set(key, { pub: fx.pub, fingerprint: next.fingerprint });
    const r = await call("fmrl_whoami");
    expect(r.isError).toBeFalsy();
    expect(text(r)).not.toContain("Private page keys:");
    expect(text(r)).not.toContain("First sync:");
    expect(r.structuredContent).not.toHaveProperty("account_vault");
    expect(ringRequests()).toHaveLength(0);
  });
  it.each([false, true])("every successful inline and file publish syncs after success (linked=%s)", async linked => {
    const key = await seed();
    if (linked) fake.linked.add(key);
    const offset = await warm();
    const file = path.join(dir, "sync.md");
    await writeFile(file, "# File sync");
    const replies = [];
    for (const priv of [false, true]) {
      replies.push(await call("fmrl_publish", { content: "# Inline sync", private: priv }));
      replies.push(await call("fmrl_publish_file", { path: file, private: priv }));
    }
    expect(replies.every(r => !r.isError)).toBe(true);
    expect(fake.requests.slice(offset).map(q => [q.method, q.path, q.auth])).toEqual(
      Array.from({ length: 4 }, () => [
        ["POST", "/api/v1/publish", `Bearer ${key}`],
        ["GET", "/api/v1/me", `Bearer ${key}`],
        ["PUT", "/api/v1/me/rings", `Bearer ${key}`],
      ]).flat(),
    );
    expect(text(replies[0])).toContain(firstPin(fx.fingerprint));
    expect(replies.slice(1).every(r => !text(r).includes("First sync:"))).toBe(true);
    expect(replies.every(r => !text(r).includes("Private page keys:"))).toBe(true);
    expect(fake.publishes.get(key)).toBe(4);
    if (linked) expect(replies.every(r => !r.structuredContent?.attach_url)).toBe(true);
    else expect(replies.every(r => RING_PAIR.test(r.structuredContent?.attach_url as string))).toBe(true);
    for (const r of replies.slice(2)) expect(r.structuredContent?.url).toContain("#p=");
  });
  it("two identical publishes and two whoami calls sync four times without throttle", async () => {
    await seed();
    const offset = await warm();
    await call("fmrl_publish", { visibility: "public", content: "# Same" });
    await call("fmrl_publish", { visibility: "public", content: "# Same" });
    await call("fmrl_whoami");
    await call("fmrl_whoami");
    expect(fake.requests.slice(offset).filter(q => q.path === "/api/v1/me")).toHaveLength(4);
    expect(ringRequests()).toHaveLength(4);
  });
  it("blank, oversized, denied and failed publishes never sync", async () => {
    const key = await seed();
    const offset = await warm();
    const big = path.join(dir, "oversized.md");
    await writeFile(big, "a".repeat(MAX_BYTES + 1));
    expect((await call("fmrl_publish", { visibility: "public", content: " " })).isError).toBe(true);
    expect((await call("fmrl_publish", { content: "a".repeat(MAX_BYTES), private: true })).isError).toBe(true);
    expect((await call("fmrl_publish_file", { visibility: "public", path: big })).isError).toBe(true);
    fake.quota = 0;
    expect((await call("fmrl_publish", { visibility: "public", content: "# Denied" })).isError).toBe(true);
    fake.quota = 25;
    expect((await call("fmrl_publish", { visibility: "public", content: "a".repeat(MAX_BYTES + 1) })).isError).toBe(true);
    expect(fake.requests.slice(offset).filter(q => q.path === "/api/v1/me")).toHaveLength(0);
    expect(ringRequests()).toHaveLength(0);
    expect(fake.publishes.get(key)).toBeUndefined();
  });
  it("publish replacing an invalid stored key syncs with its replacement bearer", async () => {
    const key = await seed();
    await warm();
    fake.keys.delete(key);
    const offset = fake.requests.length;
    // The server only learns the replacement after mint; advertise the vault there.
    const original = fake.accountVaults.get.bind(fake.accountVaults);
    const has = fake.accountVaults.has.bind(fake.accountVaults);
    fake.accountVaults.has = k => fake.keys.has(k) || has(k);
    fake.accountVaults.get = k => original(k) ?? { pub: fx.pub, fingerprint: fx.fingerprint };
    const r = await call("fmrl_publish", { visibility: "public", content: "# Replacement" });
    expect(r.isError).toBeFalsy();
    const replacement = (await readCredentials(credFile)).keys[fake.baseUrl].key;
    expect(replacement).not.toBe(key);
    expect(ringRequests()).toHaveLength(2);
    expect(ringRequests().every(q => q.auth === `Bearer ${replacement}`)).toBe(true);
    expect(fake.ringBoxes.has(fake.prefixOf(replacement))).toBe(true);
    const successfulPublish = fake.requests.slice(offset).filter(q => q.path === "/api/v1/publish").at(-1)!;
    expect(fake.requests.slice(fake.requests.indexOf(successfulPublish) + 1).map(q => q.path)).toEqual(["/api/v1/me", "/api/v1/me/rings", "/api/v1/me/rings"]);
    expect(fake.publishes.get(replacement)).toBe(1);
  });
  it("vault sync 401 never remints or republishes a successful publish", async () => {
    const key = await seed();
    await warm();
    fake.ringStatus = 401;
    const r = await call("fmrl_publish", { visibility: "public", content: "# Once" });
    expect(r.isError).toBeFalsy();
    expect(fake.requests.filter(q => q.path === "/api/v1/keys")).toHaveLength(1);
    expect(fake.requests.filter(q => q.path === "/api/v1/publish")).toHaveLength(1);
    expect(ringRequests()).toHaveLength(1);
    expect(fake.publishes.get(key)).toBe(1);
  });
  it("primary revoked whoami preserves revocation and never syncs or mints", async () => {
    const key = await seed();
    await warm();
    const offset = fake.requests.length;
    fake.revoked.add(key);
    const r = await call("fmrl_whoami");
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("was revoked, so it will not work again");
    expect(fake.requests.slice(offset).map(q => q.path)).toEqual(["/api/v1/me"]);
    expect(ringRequests()).toHaveLength(0);
  });
  it("concurrent publish sync notices stay with their invocation and appear once", async () => {
    await seed();
    await warm();
    const results = await Promise.all([
      call("fmrl_publish", { visibility: "public", content: "# First" }),
      call("fmrl_publish", { content: "# Second", private: true }),
    ]);
    expect(results.every(r => !r.isError)).toBe(true);
    expect(results.filter(r => text(r).includes(firstPin(fx.fingerprint)))).toHaveLength(1);
    expect(ringRequests()).toHaveLength(2);
    expect(text(results[0])).not.toContain("This page is private:");
    expect(text(results[1])).toContain("This page is private:");
  });
  it("vault sync secrets and raw error messages never leak through MCP results or logs", async () => {
    const key = await seed();
    fake.linked.add(key);
    const rings = [newRing(), newRing(), newRing()];
    const credentials = await readCredentials(credFile);
    await writeCredentials(credFile, { ...credentials, rings: { fmrl_OLD1: rings[0], fmrl_OLD2: rings[1], fmrl_OLD3: rings[2] } });
    const api = new FmrlApi(fake.baseUrl);
    const me = api.me.bind(api);
    api.me = async k => { const { attach_url: ignored, ...rest } = await me(k); return rest; };
    const logs: string[] = [];
    const c = await connect({ api, keys: new KeyStore({ api, baseUrl: fake.baseUrl, file: credFile }), log: l => logs.push(l) });
    try {
      const results = [(await c.callTool({ name: "fmrl_whoami", arguments: {} })) as ToolResult];
      expect(ringRequests()).toHaveLength(1);
      const boxes = fake.ringBatches.flat().map(b => b.box);
      const activeRing = (await readCredentials(credFile)).keys[fake.baseUrl].ring!;
      api.putRings = async () => { throw new ApiError(500, "secret_error", [...rings, activeRing, fx.vault_key, fx.private_pkcs8, fx.pub, ...boxes].join("|")); };
      results.push((await c.callTool({ name: "fmrl_publish", arguments: { visibility: "public", content: "# Public" } })) as ToolResult);
      results.push((await c.callTool({ name: "fmrl_whoami", arguments: {} })) as ToolResult);
      expect(results.every(r => !r.isError)).toBe(true);
      const output = JSON.stringify({ results, logs });
      for (const secret of [...rings, activeRing, fx.vault_key, fx.private_pkcs8, fx.pub, ...boxes]) expect(output).not.toContain(secret);
      expect(logs).toEqual(["fmrl-mcp: vault sync failed", "fmrl-mcp: vault sync failed"]);
    } finally { await c.close(); }
  });
});

describe("tools", () => {
  it("lists exactly the fourteen tools", async () => {
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual(["fmrl_attach", "fmrl_delete", "fmrl_edit", "fmrl_get", "fmrl_inbox", "fmrl_list", "fmrl_publish", "fmrl_publish_file", "fmrl_redeem", "fmrl_rotate", "fmrl_set_visibility", "fmrl_status", "fmrl_watch", "fmrl_whoami"]);
  });
  it("fmrl_attach answers the link with the ring, the code and the machine, and is a no-op once attached", async () => {
    const r = await call("fmrl_attach", { machine: "Prodigal" });
    expect(r.isError).toBeFalsy();
    const s = r.structuredContent as { attached: boolean; attach_url: string; code: string; machine: string };
    expect(s.attached).toBe(false);
    expect(s.code).toBe("K7Q-4MZ");
    expect(s.machine).toBe("Prodigal");
    expect(s.attach_url).toMatch(/^https:\/\/fmrl\.test\/c\/attachcmd/);
    expect(s.attach_url).toMatch(RING_PAIR);
    const req = fake.requests.filter((q) => q.path === "/api/v1/me/attach").at(-1)!;
    expect(req.body).toEqual({ machine: "Prodigal" });
    expect(text(r)).toContain("Open this link to attach this agent on Prodigal to your fmrl account:");
    expect(text(r)).toContain("Code on the page: K7Q-4MZ");
    expect(text(r)).toContain("It works once, for 10 minutes.");
    fake.linked.add(keyOf(req));
    const before = fake.requests.filter((q) => q.path === "/api/v1/me/attach").length;
    const again = await call("fmrl_attach");
    expect(fake.requests.filter((q) => q.path === "/api/v1/me/attach").length).toBe(before);
    expect(again.isError).toBeFalsy();
    expect(again.structuredContent).toMatchObject({ attached: true, attached_at: "2026-09-16T12:00:00Z" });
    expect(again.structuredContent?.attach_url).toBeUndefined();
    expect(text(again)).toContain("is already attached to your fmrl account (since 2026-09-16T12:00:00Z).");
  });
  it("fmrl_attach, already attached with no machine, names this computer and mints nothing", async () => {
    await call("fmrl_publish", { visibility: "public", content: "# Hi" });
    const key = keyOf(firstPublish());
    fake.linked.add(key);
    const r = await call("fmrl_attach");
    expect(r.isError).toBeFalsy();
    expect(fake.requests.filter((q) => q.path === "/api/v1/me/attach")).toHaveLength(0);
    const put = fake.requests.filter((q) => q.path === "/api/v1/me/machine");
    expect(put.map((q) => q.body)).toEqual([{ machine: machineName() }]);
    expect(r.structuredContent).toMatchObject({ attached: true, renamed: true, machine: machineName() });
    expect(text(r)).toContain(`Your account now shows it as on ${machineName()}.`);
    // Named now, so a second call with no machine changes nothing.
    const again = await call("fmrl_attach");
    expect(fake.requests.filter((q) => q.path === "/api/v1/me/machine")).toHaveLength(1);
    expect(again.structuredContent).toMatchObject({ attached: true, machine: machineName() });
    expect(again.structuredContent).not.toHaveProperty("renamed");
    expect(text(again)).toContain("Nothing to do.");
  });
  it("fmrl_attach, already attached, renames to a machine the person names but never to the host name over theirs", async () => {
    await call("fmrl_publish", { visibility: "public", content: "# Hi" });
    const key = keyOf(firstPublish());
    fake.linked.add(key);
    fake.machines.set(key, "Homebase");
    const kept = await call("fmrl_attach");
    expect(fake.requests.filter((q) => q.path === "/api/v1/me/machine")).toHaveLength(0);
    expect(text(kept)).toContain("This agent on Homebase is already attached");
    const same = await call("fmrl_attach", { machine: "  Homebase " });
    expect(fake.requests.filter((q) => q.path === "/api/v1/me/machine")).toHaveLength(0);
    expect(same.structuredContent).not.toHaveProperty("renamed");
    const r = await call("fmrl_attach", { machine: "Prodigal" });
    expect(fake.requests.filter((q) => q.path === "/api/v1/me/machine").map((q) => q.body)).toEqual([{ machine: "Prodigal" }]);
    expect(fake.machines.get(key)).toBe("Prodigal");
    expect(text(r)).toContain("Your account now shows it as on Prodigal.");
  });
  it("fmrl_attach, already attached, stays a quiet no-op on a server without the rename route, and says so when the rename fails", async () => {
    await call("fmrl_publish", { visibility: "public", content: "# Hi" });
    fake.linked.add(keyOf(firstPublish()));
    fake.machineStatus = 404;
    const old = await call("fmrl_attach", { machine: "Prodigal" });
    expect(old.isError).toBeFalsy();
    expect(old.structuredContent).not.toHaveProperty("renamed");
    expect(text(old)).toContain("Nothing to do.");
    fake.machineStatus = 429;
    const r = await call("fmrl_attach", { machine: "Prodigal" });
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent).toMatchObject({ attached: true, renamed: false });
    expect(text(r)).toContain("its machine name couldn't be updated just now");
    expect(fake.requests.filter((q) => q.path === "/api/v1/me/attach")).toHaveLength(0);
  });
  it("fmrl_attach names this computer when no machine is given", async () => {
    await call("fmrl_attach");
    const req = fake.requests.filter((q) => q.path === "/api/v1/me/attach").at(-1)!;
    expect(req.body).toEqual({ machine: machineName() });
  });
  it("fmrl_publish mints a key on first use and returns url, expiry, the seven-days line and the manage link", async () => {
    const r = await call("fmrl_publish", { visibility: "public", content: "# Hello", title: "Hello" });
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
      `Recovery link (grants management and editing; does not remove the page; share the page URL with it): https://fmrl.test/c/tok${id}manage0`,
      `Attach this agent to your identity: open https://fmrl.test/attach/fresh#r=${prefix}.${ring} in your browser. It also carries the ring that lets that browser open your private pages.`,
    ]);
    expect(r.structuredContent).toMatchObject({ id, url: `https://fmrl.test/${id}`, status: "live" });
    expect(r.structuredContent).toMatchObject({ attach_url: `https://fmrl.test/attach/fresh#r=${prefix}.${ring}` });
    expect(fake.requests.map((q) => q.path)).toEqual(["/api/v1/keys", "/api/v1/me", "/api/v1/me", "/api/v1/publish", "/api/v1/me"]);
    expect(firstPublish().body).toEqual({ content: "# Hello", title: "Hello" });
  });
  it("fmrl_publish passes an explicit format", async () => {
    await call("fmrl_publish", { visibility: "public", content: "x", format: "html" });
    expect(lastPublish()?.body).toEqual({ content: "x", format: "html" });
  });
  it("fmrl_publish_file maps the extension, refuses others, and caps the size", async () => {
    const md = path.join(dir, "note.MD");
    await writeFile(md, "# From a file");
    const ok = await call("fmrl_publish_file", { visibility: "public", path: md });
    expect(ok.isError).toBeFalsy();
    expect(lastPublish()?.body).toEqual({ content: "# From a file", format: "md" });
    const pdf = path.join(dir, "x.pdf");
    await writeFile(pdf, "%PDF");
    const bad = await call("fmrl_publish_file", { visibility: "public", path: pdf });
    expect(bad.isError).toBe(true);
    expect(text(bad)).toMatch(/\.html, \.htm, \.md, \.markdown, \.mdx, \.txt/);
    const big = path.join(dir, "big.md");
    await writeFile(big, "a".repeat(2 * 1024 * 1024 + 1));
    const tooBig = await call("fmrl_publish_file", { visibility: "public", path: big });
    expect(tooBig.isError).toBe(true);
    expect(text(tooBig)).toBe("That's bigger than the 2 MiB limit.");
    expect(fake.requests.filter((q) => q.path === "/api/v1/publish")).toHaveLength(1);
  });
  it("fmrl_publish_file publishes a file of exactly MAX_BYTES", async () => {
    const exact = path.join(dir, "exact.md");
    await writeFile(exact, "a".repeat(MAX_BYTES));
    const r = await call("fmrl_publish_file", { visibility: "public", path: exact });
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
      const r = (await client2.callTool({ name: "fmrl_publish_file", arguments: { visibility: "public", path: big } })) as ToolResult;
      expect(r.isError).toBe(true);
      expect(text(r)).toBe("That's bigger than the 2 MiB limit.");
      expect(fake.requests.filter((q) => q.path === "/api/v1/publish")).toHaveLength(0);
    } finally {
      await client2.close();
      await server2.close();
    }
  });
  it("fmrl_get and fmrl_delete accept an id or a URL", async () => {
    const pub = await call("fmrl_publish", { visibility: "public", content: "x" });
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
  it("fmrl_get asks the server about a house page's slug instead of refusing it at the door", async () => {
    // h4ndrv is the handoff-review starter at https://fmrl.site/h4ndrv; the
    // fake knows no such page, so the answer is the server's, not the parser's.
    // The fake's base is a 127.0.0.1 address, so a link on it stands in for a preview's.
    for (const id of ["h4ndrv", `${fake.baseUrl}/h4ndrv`, "https://fmrl.site/h4ndrv"]) {
      const r = await call("fmrl_get", { id });
      expect(r.isError).toBe(true);
      expect(text(r)).not.toMatch(/not a page id/);
      expect(text(r)).toBe("No page with that id.");
    }
    expect(fake.requests.filter((q) => q.path === "/api/v1/docs/h4ndrv")).toHaveLength(3);
  });
  it("fmrl_whoami reports the quota", async () => {
    const r = await call("fmrl_whoami");
    expect(r.isError).toBeFalsy();
    expect(text(r)).toMatch(/fmrl_\w{4}…: 0 of 25 publishes used this month, resets 2026-10-01T00:00:00Z/);
    expect(r.structuredContent).toMatchObject({ quota: { publishes: { used: 0, limit: 25 } } });
  });
  it("fmrl_publish says nothing about a link once the key is linked", async () => {
    const first = await call("fmrl_publish", { visibility: "public", content: "# a" });
    fake.linked.add((fake.requests.at(-1)!.auth as string).slice(7));
    const r = await call("fmrl_publish", { visibility: "public", content: "# b" });
    expect(text(first)).toContain("Attach this agent to your identity");
    expect(text(r)).not.toContain("See your pages");
    expect(r.structuredContent).not.toHaveProperty("attach_url");
  });
  it("fmrl_whoami says whether a browser is linked and always offers a link", async () => {
    const r = await call("fmrl_whoami");
    expect(text(r)).toContain("This agent is not attached to an identity, so its canvases don't show on fmrl.site yet.");
    expect(text(r)).toContain("open https://fmrl.test/attach/fresh#r=");
    expect(text(r)).toMatch(/Once it is attached, its canvases show at http:\/\/127\.0\.0\.1:\d+\/\?canvases, tagged fmrl_\w{4}\.$/m);
    expect(r.structuredContent).toMatchObject({ attached_at: null, attach_url: expect.stringMatching(/^https:\/\/fmrl\.test\/attach\/fresh#r=/) });
    fake.linked.add((fake.requests.at(-1)!.auth as string).slice(7));
    const again = await call("fmrl_whoami");
    expect(text(again)).toContain("This agent attached to its identity on 2026-09-16T12:00:00Z.");
    expect(again.structuredContent).toMatchObject({ attached_at: "2026-09-16T12:00:00Z" });
  });
  it("a 402 is a tool error with the reset time and is not retried", async () => {
    fake.quota = 0;
    const r = await call("fmrl_publish", { visibility: "public", content: "x" });
    expect(r.isError).toBe(true);
    expect(text(r)).toBe("This key has used its free publishes for the month; it resets at 2026-10-01T00:00:00Z.");
    expect(fake.requests.filter((q) => q.path === "/api/v1/publish")).toHaveLength(1);
  });
  it("a 422 is a tool error with the API's message", async () => {
    const r = await call("fmrl_publish", { visibility: "public", content: "PHISH" });
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
      const r = await call("fmrl_publish_file", { visibility: "public", path: `~/${name}` });
      expect(r.isError).toBeFalsy();
      expect(lastPublish()?.body).toEqual({ content: "# Home file", format: "md" });
    } finally {
      await unlink(abs);
    }
  });
  it("fmrl_publish_file rejects a non-UTF-8 file without publishing", async () => {
    const bad = path.join(dir, "bad.md");
    await writeFile(bad, Buffer.from([0xff, 0xfe, 0xfd, 0xfc]));
    const r = await call("fmrl_publish_file", { visibility: "public", path: bad });
    expect(r.isError).toBe(true);
    expect(text(r)).toBe("That file isn't UTF-8 text.");
    expect(fake.requests.filter((q) => q.path === "/api/v1/publish")).toHaveLength(0);
  });
  it("fmrl_publish reports the server's 413 for oversized content", async () => {
    const r = await call("fmrl_publish", { visibility: "public", content: "a".repeat(2 * 1024 * 1024 + 1) });
    expect(r.isError).toBe(true);
    expect(text(r)).toBe("That's bigger than the 2 MiB limit.");
  });
  it("fmrl_get renders a pinned page as kept forever with its CID", async () => {
    const pub = await call("fmrl_publish", { visibility: "public", content: "x", title: "PINNED" });
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
    expect(html).toContain('<h1 id="quiet">Quiet</h1>');
    expect(html).toContain("<title>Quiet</title>");
    const t = text(r);
    expect(t).toContain(`Published: ${url}`);
    expect(t).toContain("private");
    expect(t).toContain("This page lasts seven days; a private page cannot be kept.");
    expect(t).not.toContain("keeps it");
    expect((r.structuredContent as { manage_url: string }).manage_url).not.toContain("#p=");

    const titled = await call("fmrl_publish", { content: "# Quiet\n\nhello", private: true, title: "Custom Title" });
    expect(titled.isError).toBeFalsy();
    const titledBody = lastPublish()?.body as { content: string; title?: string };
    expect(titledBody.title).toBeUndefined();
    const titledKey = /#p=([A-Za-z0-9_-]{43})$/.exec((titled.structuredContent as { url: string }).url)![1];
    const titledHtml = await openEnvelope(titledBody.content, { key: titledKey });
    expect(titledHtml).toContain("<title>Custom Title</title>");
  });
  it("fmrl_publish refuses a passphrase argument: there is no passphrase mode", async () => {
    const r = await call("fmrl_publish", { visibility: "public", content: "<h1>x</h1>", passphrase: "open sesame" });
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
    await call("fmrl_publish", { visibility: "public", content: "# Plain" });
    expect(firstPublish().body).toEqual({ content: "# Plain" });
  });
  it("fmrl_publish private: whitespace-only content is refused before sending", async () => {
    const r = await call("fmrl_publish", { content: "  \n ", private: true });
    expect(r.isError).toBe(true);
    expect(fake.requests.some((q) => q.path === "/api/v1/publish")).toBe(false);
  });
  it("fmrl_publish public: whitespace-only content is refused before sending", async () => {
    const r = await call("fmrl_publish", { visibility: "public", content: "  \n ", format: "md" });
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
    const pair = RING_PAIR.exec((r.structuredContent as { attach_url: string }).attach_url)!;
    expect(pair[1]).toBe(keyOf(firstPublish()).slice(0, 9));
    expect(pair[2]).toBe(ring);
    // The ring shows in the reply only inside the link.
    expect(text(r).split(ring)).toHaveLength(2);
  });
  it("fmrl_publish private html: the record carries the explicit title, else the <title>", async () => {
    const html = "<!DOCTYPE html><html><head><title>Board notes</title></head><body><h1>Other</h1></body></html>";
    await call("fmrl_publish", { content: html, private: true });
    const ring = (await ringInFile())!;
    const first = lastPublish().body as { sealed: string };
    expect((await openRecord(ring, first.sealed)).title).toBe("Board notes");
    await call("fmrl_publish", { content: html, private: true, title: "Custom" });
    const second = lastPublish().body as { sealed: string };
    expect((await openRecord(ring, second.sealed)).title).toBe("Custom");
  });
  it("a publish with no link to relay mints no ring", async () => {
    const key = "fmrl_" + "L".repeat(32);
    await writeCredentials(credFile, { version: 1, keys: { [fake.baseUrl]: { key, prefix: key.slice(0, 9), created_at: "x" } } });
    fake.keys.add(key);
    fake.linked.add(key);
    const r = await call("fmrl_publish", { visibility: "public", content: "# a" });
    expect(r.structuredContent).not.toHaveProperty("attach_url");
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
    expect(RING_PAIR.exec((r.structuredContent as { attach_url: string }).attach_url)![2]).toBe(ring);
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
      expect(lastPublish().body as Record<string, unknown>).not.toHaveProperty("sealed");
      expect((r.structuredContent as { url: string }).url).toMatch(/#p=[A-Za-z0-9_-]{43}$/);
      expect((r.structuredContent as { attach_url: string }).attach_url).not.toContain("#r=");
      // A link without #r= must not claim to carry the ring.
      expect(text(r)).toContain("Attach this agent to your identity: open ");
      expect(text(r)).not.toContain("It also carries the ring");
      expect(logs.join("\n")).toMatch(/couldn't save a key ring/);
      const who = (await client2.callTool({ name: "fmrl_whoami", arguments: {} })) as ToolResult;
      expect(text(who)).toContain(`Couldn't save a key ring to ${path.join(blocker, "credentials.json")} (`);
      expect(text(who)).toContain("Attach this agent to your identity: open ");
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
  it("whoami provides one intact custom-origin handoff with optional account and backup meaning", async () => {
    const r = await call("fmrl_whoami");
    const t = text(r);
    const link = r.structuredContent!.attach_url as string;
    expect(t.split(link)).toHaveLength(2);
    expect(t).toContain("Attach this agent to your identity");
    expect(t).toContain("in your browser");
    expect(t).toContain("This agent is not attached");
    expect(t).not.toContain("Signing in does not back up private-page keys");
    expect(t).not.toContain("https://fmrl.site");
    expect(t).not.toContain(keyOf(fake.requests.at(-1)!));
    expect(fake.requests.some(q => q.path.includes("publish"))).toBe(false);
  });
  it("historical linking and a missing link do not invent current account state or a destination", async () => {
    const api = new FmrlApi(fake.baseUrl);
    const original = api.me.bind(api);
    vi.spyOn(api, "me").mockImplementation(async k => ({ ...await original(k), attached_at: "2026-09-16", attach_url: undefined }));
    const keys = new KeyStore({ api, baseUrl: fake.baseUrl, file: credFile });
    const c = await connect({ api, keys });
    try {
      const r = await c.callTool({ name: "fmrl_whoami", arguments: {} }) as ToolResult;
      expect(text(r)).toContain("This agent attached to its identity on 2026-09-16");
      expect(text(r)).not.toContain("browser linked");
      expect(text(r)).not.toContain("No attach link");
      // The one address is where its canvases are; no attach or link destination is invented.
      expect(text(r).match(/https?:\/\/\S+/g)).toEqual([`${fake.baseUrl}/?canvases,`]);
      expect(text(r)).toContain("in the browser it was attached from and any browser signed in to that person's fmrl account");
      expect(text(r)).not.toContain("you are signed in");
    } finally { await c.close(); }
  });
  it.each([
    ["account", "This agent attached to your fmrl account on 2026-10-18T12:00:00Z.", "Its canvases are in your canvases at https://fmrl.site/?canvases, tagged fmrl_Bsrk, in any browser signed in to that account."],
    ["browser", "This agent attached on 2026-10-18T12:00:00Z to the browser it was attached from, which has no fmrl account.", "That browser shows its canvases at https://fmrl.site/?canvases, tagged fmrl_Bsrk. To see them on other devices, sign in to fmrl from that browser:"],
  ] as const)("fmrl_whoami says where an agent attached via its %s sees its canvases", async (via, attached, where) => {
    const api = new FmrlApi(fake.baseUrl);
    const original = api.me.bind(api);
    vi.spyOn(api, "me").mockImplementation(async k => ({ ...await original(k), prefix: "fmrl_Bsrk", attached_at: "2026-10-18T12:00:00Z", attached_via: via, canvases_url: "https://fmrl.site/?canvases", attach_url: undefined }));
    const keys = new KeyStore({ api, baseUrl: fake.baseUrl, file: credFile });
    const c = await connect({ api, keys });
    try {
      const r = await c.callTool({ name: "fmrl_whoami", arguments: {} }) as ToolResult;
      expect(text(r)).toContain(`${attached}\n${where}`);
      expect(text(r)).not.toContain("No attach link");
      // Claude Code may hand the model only the structured half: the same facts and sentence are there.
      expect(r.structuredContent).toMatchObject({ attached_via: via, canvases_url: "https://fmrl.site/?canvases", canvases: expect.stringContaining(where) });
    } finally { await c.close(); }
  });
  it("fmrl_whoami mints the ring, carries it on the link, and names the file to back up", async () => {
    const r = await call("fmrl_whoami");
    expect(r.isError).toBeFalsy();
    const ring = (await ringInFile())!;
    const prefix = keyOf(fake.requests.at(-1)!).slice(0, 9);
    expect(ring).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(r.structuredContent).toMatchObject({ attach_url: `https://fmrl.test/attach/fresh#r=${prefix}.${ring}` });
    expect(text(r)).toContain(`open https://fmrl.test/attach/fresh#r=${prefix}.${ring} in your browser. It also carries the ring that lets that browser open your private pages.`);
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
      expect(RING_PAIR.exec((r.structuredContent as { attach_url: string }).attach_url)![2]).toBe(envRing);
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
    const pub = await call("fmrl_publish", { visibility: "public", content: "# Open" });
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

describe("visibility: private unless asked (#30)", () => {
  const posts = () => fake.requests.filter((q) => q.method === "POST" && q.path.endsWith("/publish"));
  const awsKey = "AKIA" + "Q7RZ3MXK5T2WB9PD";

  it("publishes private when neither visibility nor private is given", async () => {
    const r = await call("fmrl_publish", { content: "# Inventory\n\nwhere the keys live" });
    expect(r.isError).toBeFalsy();
    expect((r.structuredContent as { url: string }).url).toContain("#p=");
    expect(posts().at(-1)?.body).toMatchObject({ encrypted: true });
    expect(JSON.stringify(posts().at(-1)?.body)).not.toContain("where the keys live");
    expect(text(r)).toContain(SEVEN_DAYS_PRIVATE);
  });
  it("publishes in the clear only on visibility public, or private: false from older callers", async () => {
    for (const args of [{ visibility: "public" }, { private: false }]) {
      const r = await call("fmrl_publish", { content: "# Open", ...args });
      expect(r.isError).toBeFalsy();
      expect((r.structuredContent as { url: string }).url).not.toContain("#p=");
      expect(posts().at(-1)?.body).toMatchObject({ content: "# Open" });
    }
    const sealed = await call("fmrl_publish", { content: "# Closed", visibility: "private" });
    expect((sealed.structuredContent as { url: string }).url).toContain("#p=");
  });
  it("keeps a private Markdown page's source with it, so a read gives back the Markdown and its profile, not the HTML it became", async () => {
    const md = "# Plan\n\nstep <one> & two\n\n```fmrl-profile\nsections:\n  - id: plan\n    heading: Plan\n```\n";
    const r = await call("fmrl_publish", { content: md, format: "md" });
    const { url } = r.structuredContent as { url: string };
    const got = await call("fmrl_get", { id: url });
    expect(got.isError).toBeFalsy();
    expect(got.structuredContent).toMatchObject({ content: md, content_format: "md" });
  });
  it("names the public option when a page fits public but not once encrypted", async () => {
    const big = "# Big\n\n" + "word ".repeat(330_000);
    const r = await call("fmrl_publish", { content: big, format: "md" });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('visibility: "public"');
  });
  it("refuses visibility and private that disagree, sending nothing", async () => {
    const n = posts().length;
    const r = await call("fmrl_publish", { content: "# Which", visibility: "public", private: true });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("disagree");
    expect(posts()).toHaveLength(n);
  });
  it("refuses public content that carries a credential, names the kind and not the value, and lets it go private", async () => {
    const n = posts().length;
    const r = await call("fmrl_publish", { content: `# Setup\n\naws_access_key_id = ${awsKey}`, visibility: "public" });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("an AWS access key");
    expect(text(r)).not.toContain(awsKey);
    expect(posts()).toHaveLength(n);
    const priv = await call("fmrl_publish", { content: `# Setup\n\naws_access_key_id = ${awsKey}` });
    expect(priv.isError).toBeFalsy();
  });
  it("applies the same rules to fmrl_publish_file", async () => {
    const work = await mkdtemp(path.join(tmpdir(), "fmrl-vis-"));
    const f = path.join(work, "inventory.md");
    await writeFile(f, "# Inventory\n\n-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n");
    const pub = await call("fmrl_publish_file", { path: f, visibility: "public" });
    expect(pub.isError).toBe(true);
    expect(text(pub)).toContain("a private key block");
    const priv = await call("fmrl_publish_file", { path: f });
    expect(priv.isError).toBeFalsy();
    expect((priv.structuredContent as { url: string }).url).toContain("#p=");
  });
  it("refuses an edit that would put a credential on a public page", async () => {
    const pub = await call("fmrl_publish", { content: "# Notes", visibility: "public" });
    const id = (pub.structuredContent as { id: string }).id;
    const token = "ghp_" + "aB3dE5gH7jK9mN2pQ4sT6vW8yZ1cF0xLaB3d";
    const r = await call("fmrl_edit", { id, content: `# Notes\n\n${token}`, base_rev: 1 });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("a GitHub token");
    expect(text(r)).not.toContain(token);
    expect(fake.requests.filter((q) => q.method === "PUT")).toHaveLength(0);
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
    expect(tool.description).toBe("Read a page by id or link: its metadata and, for revision `rev` (default the latest), its content. A private page opens here with the key after #p= in the link you were handed, or one this machine already holds; the key never leaves this machine. Reading a revision of a page you watch marks it seen. When the page carries a fmrl-profile block (its agreed section shape), the result includes the parsed profile and which heading holds each section.");
  });
  it("reads a public Markdown page's latest revision: its source, its format, and who wrote it", async () => {
    const pub = await call("fmrl_publish", { visibility: "public", content: "# Hello\n\nworld", format: "md" });
    const id = (pub.structuredContent as { id: string }).id;
    const prefix = keyOf(fake.requests.at(-1)!).slice(0, 9);
    const got = await call("fmrl_get", { id: `https://fmrl.test/${id}` });
    expect(got.isError).toBeFalsy();
    expect(got.structuredContent).toMatchObject({
      id, url: `https://fmrl.test/${id}`, private: false, rev: 1, latest_rev: 1,
      editor: { kind: "key", key: prefix, label: "test" }, content: "# Hello\n\nworld", content_format: "md",
    });
    expect(got.structuredContent).not.toHaveProperty("content_note");
    expect(fake.requests.at(-1)).toMatchObject({ method: "GET", path: `/api/v1/docs/${id}/revisions/1` });
    const lines = text(got).split("\n");
    expect(lines[0]).toMatch(new RegExp(`^https://fmrl\\.test/${id}: live, md, `));
    expect(lines[1]).toBe(`Revision 1 of 1, edited by test (${prefix}…) at 2026-09-08T12:00:00.000Z.`);
    expect(text(got).endsWith("\n\n# Hello\n\nworld")).toBe(true);
  });
  it("reads an older revision when rev is given, and the latest otherwise", async () => {
    const pub = await call("fmrl_publish", { visibility: "public", content: "# One", format: "md" });
    const id = (pub.structuredContent as { id: string }).id;
    const key = keyOf(fake.requests.at(-1)!);
    fake.labels.set(key, "claude-code");
    await new FmrlApi(fake.baseUrl).update(key, id, { content: "# Two", format: "md" });
    const old = await call("fmrl_get", { id, rev: 1 });
    expect(old.structuredContent).toMatchObject({ rev: 1, latest_rev: 2, content: "# One", content_format: "md" });
    const latest = await call("fmrl_get", { id });
    expect(latest.structuredContent).toMatchObject({ rev: 2, latest_rev: 2, content: "# Two", editor: { kind: "key", key: key.slice(0, 9), label: "claude-code" } });
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
    const priv = await call("fmrl_publish", { content: "<!DOCTYPE html><html><head><title>Quiet</title></head><body><h1>Quiet</h1><p>hello</p></body></html>", format: "html", private: true });
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
  const PROFILE = {
    profile: "handoff-review", v: 1,
    sections: [{ id: "header", purpose: "who and what", by: "author", required: true }, { id: "review-map", purpose: "where to look", by: "author", required: true }],
    norms: ["evidence is a results table, not a transcript"],
  };
  const withProfile = (p: unknown) => "# Handoff\n\n```fmrl-profile\n" + JSON.stringify(p) + "\n```\n\n## Header\n\nx\n";
  it("reads a public page's profile and section map, and says so in the text", async () => {
    const pub = await call("fmrl_publish", { visibility: "public", content: withProfile(PROFILE), format: "md" });
    const id = (pub.structuredContent as { id: string }).id;
    const got = await call("fmrl_get", { id });
    expect(got.isError).toBeFalsy();
    expect(got.structuredContent).toMatchObject({
      profile: { ...PROFILE, sections: PROFILE.sections },
      section_map: { header: { heading: "Header", position: 2 } },
      missing: ["review-map"],
    });
    expect(got.structuredContent).not.toHaveProperty("profile_error");
    const lines = text(got).split("\n");
    expect(lines[2]).toBe("Profile handoff-review v1: 1 of 2 sections found; missing: review-map (required).");
    expect(lines[3]).toBe("Norm: evidence is a results table, not a transcript");
  });
  it("reads a private page's profile after opening it, from its Markdown source", async () => {
    const src = withProfile(PROFILE);
    const { id, key } = await plantPrivate(`<!DOCTYPE html><html><body><h1>Handoff</h1>\n${sourceBlock(src)}\n</body></html>`);
    const got = await call("fmrl_get", { id: `https://fmrl.test/${id}#p=${key}` });
    expect(got.structuredContent).toMatchObject({
      content: src, content_format: "md",
      profile: { profile: "handoff-review", v: 1 }, section_map: { header: { heading: "Header", position: 2 } }, missing: ["review-map"],
    });
    expect(text(got)).toContain("\nProfile handoff-review v1: 1 of 2 sections found; missing: review-map (required).\n");
  });
  it("a page with no profile block carries no profile keys at all", async () => {
    const pub = await call("fmrl_publish", { visibility: "public", content: "# Plain\n\n## Header\n", format: "md" });
    const got = await call("fmrl_get", { id: (pub.structuredContent as { id: string }).id });
    for (const k of ["profile", "section_map", "missing", "profile_error"]) expect(got.structuredContent).not.toHaveProperty(k);
    expect(text(got)).not.toContain("Profile");
  });
  it("a page whose profile block is broken says so", async () => {
    const pub = await call("fmrl_publish", { visibility: "public", content: "# Broken\n\n```fmrl-profile\n{nope\n```\n", format: "md" });
    const got = await call("fmrl_get", { id: (pub.structuredContent as { id: string }).id });
    expect(got.isError).toBeFalsy();
    const err = (got.structuredContent as { profile_error: string }).profile_error;
    expect(err).toMatch(/^the fmrl-profile block is not valid JSON: /);
    for (const k of ["profile", "section_map", "missing"]) expect(got.structuredContent).not.toHaveProperty(k);
    expect(text(got).split("\n")[2]).toBe(`Profile block unreadable: ${err}.`);
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
  const manageTok = (manageUrl: string) => new URL(manageUrl).pathname.split("/").at(-1)!;

  it("describes the tool as the brief words it", async () => {
    const tool = (await client.listTools()).tools.find((t) => t.name === "fmrl_edit")!;
    expect(tool.description).toBe("Replace a page's content with a new revision. Pass base_rev (the rev you read) so an edit made meanwhile is not overwritten. Works on your own pages and on any page whose management token you were given (pass the page URL as id and the token or recovery link separately as manage_token); a private page stays private under its same key, so every existing link keeps opening it. Editing watches the page: revisions other editors make afterwards show up in fmrl_inbox, with no fmrl_watch call.");
  });
  it("publishing remembers the page's manage token, and a private page's key", async () => {
    const pub = await call("fmrl_publish", { visibility: "public", content: "# Open" });
    const { id, manage_url } = pub.structuredContent as { id: string; manage_url: string };
    expect(await pagesAt().get(id)).toEqual({ manage: manageTok(manage_url) });
    const priv = await call("fmrl_publish", { content: "# Closed", private: true });
    const p = priv.structuredContent as { id: string; url: string; manage_url: string };
    expect(await pagesAt().get(p.id)).toEqual({ key: p.url.split("#p=")[1], manage: manageTok(p.manage_url) });
  });
  it("fmrl_get's to_file writes the content into the fmrl folder and fmrl_edit's content_file saves it back, never through the model (#33)", async () => {
    const big = "# Canvas\n\n<!-- section:a -->\nold\n<!-- /section:a -->\n\n" + "filler line\n".repeat(2000);
    const pub = await call("fmrl_publish", { content: big, format: "md", visibility: "public" });
    const id = (pub.structuredContent as { id: string }).id;

    const got = await call("fmrl_get", { id, to_file: true });
    expect(got.isError).toBeFalsy();
    const g = got.structuredContent as Record<string, unknown> & { content_file: { path: string; bytes: number } };
    expect(g).not.toHaveProperty("content");
    const out = g.content_file.path;
    // The server picks the place: the fmrl folder, made private on first use, under the page's id.
    const folder = await realpath(path.join(dir, "files"));
    expect(out).toBe(path.join(folder, `${id}.md`));
    expect((await statFile(folder)).mode & 0o777).toBe(0o700);
    expect(g).toMatchObject({ rev: 1, content_format: "md", content_file: { bytes: Buffer.byteLength(big) } });
    expect(g.content_note).toBe(CONTENT_WRITTEN(out, Buffer.byteLength(big), "md"));
    expect(text(got)).not.toContain("filler line");
    expect(await readFile(out, "utf8")).toBe(big);
    expect((await statFile(out)).mode & 0o777).toBe(0o600);
    // Nothing is left behind but the page's file.
    expect(await readdir(folder)).toEqual([`${id}.md`]);

    const edited = big.replace("old", "new");
    await writeFile(out, edited);
    const r = await call("fmrl_edit", { id, content_file: out, base_rev: 1 });
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent).toMatchObject({ id, rev: 2 });
    // The format comes from the extension when none is given.
    expect(puts().at(-1)).toMatchObject({ body: { content: edited, format: "md", base_rev: 1 } });
    expect((await call("fmrl_get", { id })).structuredContent).toMatchObject({ rev: 2, content: edited });

    // The bare file name reads from the folder too, and a second read replaces the copy in place.
    const byName = await call("fmrl_edit", { id, content_file: `${id}.md`, base_rev: 2 });
    expect(byName.isError).toBeFalsy();
    await writeFile(out, "stale");
    const again = (await call("fmrl_get", { id, to_file: true })).structuredContent as { content_file: { path: string } };
    expect(again.content_file.path).toBe(out);
    expect(await readFile(out, "utf8")).toBe(edited);

    // A copy left in the other format is an older revision: the next to_file removes it, so it can't be saved back.
    const html = path.join(folder, `${id}.html`);
    await writeFile(html, "<p>older</p>");
    await call("fmrl_get", { id, to_file: true });
    expect(await readdir(folder)).toEqual([`${id}.md`]);
  });
  it("fmrl_get's to_file takes no path, so a caller can't aim the write, and a link planted under the page's name is replaced, not followed", async () => {
    const pub = await call("fmrl_publish", { content: "ssh-ed25519 AAAA attacker", format: "md" });
    const id = (pub.structuredContent as { id: string }).id;
    const work = await realpath(await mkdtemp(path.join(tmpdir(), "fmrl-out-")));
    const target = path.join(work, "authorized_keys");
    await writeFile(target, "mine");
    await mkdir(path.join(dir, "files"), { recursive: true });
    await symlink(target, path.join(dir, "files", `${id}.md`));
    const r = await call("fmrl_get", { id, out: target, path: target, to_file: true });
    expect(r.isError).toBeFalsy();
    expect(await readFile(target, "utf8")).toBe("mine");
    expect((r.structuredContent as { content_file: { path: string } }).content_file.path).not.toContain(work);
  });
  it("fmrl_edit takes content or content_file, exactly one, and reads only the edited page's own file in the fmrl folder", async () => {
    const pub = await call("fmrl_publish", { content: "# One", format: "md" });
    const id = (pub.structuredContent as { id: string }).id;
    const folder = path.join(dir, "files");
    await mkdir(folder, { recursive: true, mode: 0o700 });
    const realFolder = await realpath(folder);
    const own = path.join(folder, `${id}.md`);
    await writeFile(own, "# Two");
    for (const args of [{ id }, { id, content: "# Two", content_file: own }]) {
      const r = await call("fmrl_edit", args);
      expect(r.isError).toBe(true);
      expect(text(r)).toBe(EDIT_ONE_SOURCE);
    }
    const tool = "fmrl_edit's content_file";
    await writeFile(path.join(folder, `${id}.png`), "x");
    const wrong = await call("fmrl_edit", { id, content_file: `${id}.png` });
    expect(wrong.isError).toBe(true);
    expect(text(wrong)).toContain("fmrl_edit's content_file reads .html");
    const missing = await call("fmrl_edit", { id, content_file: `${id}.html` });
    expect(text(missing)).toBe(NO_OWN_FILE(tool, realFolder, `${id}.html`));

    // A page file anywhere else is refused by its path alone: full path, ~, climbing out, or a folder below.
    const work = await realpath(await mkdtemp(path.join(tmpdir(), "fmrl-out-")));
    const notes = path.join(work, `${id}.md`);
    await writeFile(notes, "# My private notes");
    await writeFile(path.join(dir, `${id}.md`), "# Beside the folder");
    await mkdir(path.join(folder, "sub"));
    await writeFile(path.join(folder, "sub", `${id}.md`), "# Below");
    for (const p of [notes, path.join(folder, "..", "..", path.basename(work), `${id}.md`), `../${id}.md`, `~/${id}.md`, `sub/${id}.md`, path.join(folder, "sub", `${id}.md`), "..", "."]) {
      const r = await call("fmrl_edit", { id, content_file: p });
      expect(text(r), p).toBe(OUTSIDE_FOLDER(tool, realFolder, p));
    }

    // Another page's file in the folder, say a private page fmrl_get opened there, can't be uploaded under this one.
    const other = ((await call("fmrl_publish", { content: "# Other", format: "md" })).structuredContent as { id: string }).id;
    await writeFile(path.join(folder, `${other}.md`), "# Opened private page");
    await writeFile(path.join(folder, "readme.md"), "# Readme");
    for (const p of [`${other}.md`, path.join(folder, `${other}.md`), "readme.md", id, `${id}.md.bak`]) {
      const r = await call("fmrl_edit", { id, content_file: p });
      expect(text(r), p).toBe(NOT_OWN_FILE(tool, realFolder, p, id));
    }

    // The page's own name is still refused when it is a link out, a hard link, a folder or a FIFO.
    await unlink(own);
    await symlink(notes, own);
    const linked = await call("fmrl_edit", { id, content_file: `${id}.md` });
    expect(text(linked)).toBe(OUTSIDE_FOLDER(tool, realFolder, `${id}.md`));
    await unlink(own);
    if (process.platform !== "win32") {
      await link(notes, own);
      const hard = await call("fmrl_edit", { id, content_file: own });
      expect(text(hard)).toBe(OUTSIDE_FOLDER(tool, realFolder, own));
      await unlink(own);
    }
    await mkdir(own);
    const sub = await call("fmrl_edit", { id, content_file: `${id}.md` });
    expect(sub.isError).toBe(true);
    expect(text(sub)).toContain("is not a regular file");
    if (process.platform !== "win32") {
      const fifo = path.join(folder, `${id}.txt`);
      execFileSync("mkfifo", [fifo]);
      const started = Date.now();
      const piped = await call("fmrl_edit", { id, content_file: `${id}.txt` });
      expect(piped.isError).toBe(true);
      expect(text(piped)).toContain("is not a regular file");
      expect(Date.now() - started).toBeLessThan(2000);
    }
    expect(puts()).toHaveLength(0);
  });
  it("fmrl_edit's content_file reads the entry it checked: a file swapped for a link just before the open is refused", async () => {
    if (process.platform === "win32") return;
    const pub = await call("fmrl_publish", { content: "# One", format: "md" });
    const id = (pub.structuredContent as { id: string }).id;
    const folder = path.join(dir, "files");
    await mkdir(folder, { recursive: true, mode: 0o700 });
    const own = path.join(folder, `${id}.md`);
    await writeFile(own, "# Two");
    const work = await realpath(await mkdtemp(path.join(tmpdir(), "fmrl-out-")));
    const key = path.join(work, "id_ed25519");
    await writeFile(key, "PRIVATE KEY");
    const swap = async (...args: Parameters<typeof fsOpen>) => {
      const planted = path.join(folder, "planted");
      await symlink(key, planted);
      await rename(planted, own);
      return fsOpen(...args);
    };
    const api = new FmrlApi(fake.baseUrl);
    const raced = await connect({ api, keys: new KeyStore({ api, baseUrl: fake.baseUrl, file: credFile }), open: swap as typeof fsOpen });
    const r = (await raced.callTool({ name: "fmrl_edit", arguments: { id, content_file: `${id}.md` } })) as ToolResult;
    expect(r.isError).toBe(true);
    expect(text(r)).toBe(OUTSIDE_FOLDER("fmrl_edit's content_file", await realpath(folder), `${id}.md`));
    expect(puts()).toHaveLength(0);
    await raced.close();
  });
  it("the fmrl folder is used only if it is this user's and no one else can write in it", async () => {
    if (process.platform === "win32") return;
    const pub = await call("fmrl_publish", { content: "# One", format: "md" });
    const id = (pub.structuredContent as { id: string }).id;
    const folder = path.join(dir, "files");
    await mkdir(folder, { recursive: true });
    await chmod(folder, 0o777);
    await writeFile(path.join(folder, `${id}.md`), "# Planted");
    const got = await call("fmrl_get", { id, to_file: true });
    expect(got.isError).toBe(true);
    expect(text(got)).toContain("Other users can write in the fmrl folder");
    const ed = await call("fmrl_edit", { id, content_file: `${id}.md` });
    expect(text(ed)).toContain("Other users can write in the fmrl folder");
    await chmod(folder, 0o755);
    expect((await call("fmrl_get", { id, to_file: true })).isError).toBeFalsy();
    expect(puts()).toHaveLength(0);
  });
  it("fmrl_get's to_file opens a private page here and writes its source", async () => {
    const priv = await call("fmrl_publish", { content: "# Secret plan\n\nstep one", format: "md", private: true });
    const { url } = priv.structuredContent as { url: string };
    const got = await call("fmrl_get", { id: url, to_file: true });
    expect(got.isError).toBeFalsy();
    const out = (got.structuredContent as { content_file: { path: string } }).content_file.path;
    expect(await readFile(out, "utf8")).toContain("step one");
    expect(text(got)).not.toContain("step one");
  });
  it("the owner edits its own public page, and the next read is the new revision", async () => {
    const pub = await call("fmrl_publish", { visibility: "public", content: "# One", format: "md" });
    const id = (pub.structuredContent as { id: string }).id;
    const r = await call("fmrl_edit", { id, content: "# Two", format: "md", title: "Two", base_rev: 1 });
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent).toEqual({ id, url: `https://fmrl.test/${id}`, rev: 2, watching: true });
    expect(puts()).toHaveLength(1);
    expect(puts()[0]).toMatchObject({ path: `/api/v1/docs/${id}`, body: { content: "# Two", format: "md", title: "Two", base_rev: 1 } });
    const got = await call("fmrl_get", { id });
    expect(got.structuredContent).toMatchObject({ rev: 2, latest_rev: 2, content: "# Two" });
  });
  it("an edit watches the page: the editor hears the next revision with no fmrl_watch call", async () => {
    const pub = await call("fmrl_publish", { visibility: "public", content: "# Shared", format: "md" });
    const { id, manage_url } = pub.structuredContent as { id: string; manage_url: string };
    const b = await second();
    const r = await b.call("fmrl_edit", { id, manage_token: manage_url, content: "# Edited by B", base_rev: 1 });
    expect(r.structuredContent).toEqual({ id, url: `https://fmrl.test/${id}`, rev: 2, watching: true });
    expect(text(r)).toBe(`Saved revision 2 of https://fmrl.test/${id}. You are watching it: revisions other editors make show up in fmrl_inbox.`);
    expect(((await b.call("fmrl_inbox")).structuredContent as { items: unknown[] }).items).toEqual([]);
    await call("fmrl_edit", { id, content: "# Answered by A", base_rev: 2 });
    const inbox = (await b.call("fmrl_inbox")).structuredContent as { items: { id: string; rev: number; seen_rev: number }[] };
    expect(inbox.items).toHaveLength(1);
    expect(inbox.items[0]).toMatchObject({ id, rev: 3, seen_rev: 2 });
    expect(fake.requests.filter((q) => q.method === "PUT" && q.path.endsWith("/watch"))).toHaveLength(0);
  });
  it("an edit by a key at its watch limit is saved, and says the page is not watched", async () => {
    const pub = await call("fmrl_publish", { visibility: "public", content: "# Shared", format: "md" });
    const { id, manage_url } = pub.structuredContent as { id: string; manage_url: string };
    const b = await second();
    fake.watchLimit = 0;
    const r = await b.call("fmrl_edit", { id, manage_token: manage_url, content: "# Edited by B", base_rev: 1 });
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent).toEqual({ id, url: `https://fmrl.test/${id}`, rev: 2, watching: false });
    expect(text(r)).toBe(`Saved revision 2 of https://fmrl.test/${id}. Not watched: the page could not be added to this key's watches, usually because the key watches the most pages it may, so replies will not show up in fmrl_inbox. Call fmrl_watch to try again; it says whether the key is at its limit.`);
  });
  it("another key edits with the manage link passed once, then by bare id, the token remembered only once it worked", async () => {
    const pub = await call("fmrl_publish", { visibility: "public", content: "# Shared", format: "md" });
    const { id, manage_url } = pub.structuredContent as { id: string; manage_url: string };
    const b = await second();

    const bare = await b.call("fmrl_edit", { id, content: "# Nope" });
    expect(bare.isError).toBe(true);
    expect(text(bare)).toBe(`To edit, supply https://fmrl.test/${id} as id and its recovery token or /c/<token> link separately as manage_token. Ask whoever shares a recovery link to include the page URL. Recovery grants management, not deletion.`);

    const forged = await b.call("fmrl_edit", { id, manage_token: "f".repeat(22), content: "# Forged" });
    expect(forged.isError).toBe(true);
    expect(await b.pages.get(id)).toEqual({});

    const once = await b.call("fmrl_edit", { id, manage_token: manage_url, content: "# Edited by B", base_rev: 1 });
    expect(once.isError).toBeFalsy();
    expect(once.structuredContent).toEqual({ id, url: `https://fmrl.test/${id}`, rev: 2, watching: true });
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

    const r = await b.call("fmrl_edit", { id: `https://fmrl.test/${id}#p=${key}`, manage_token: manage_url, content: "# Plan v2\n\nsecond", format: "md", title: "Plan v2", base_rev: 1 });
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent).toEqual({ id, url: `https://fmrl.test/${id}#p=${key}`, rev: 2, watching: true });
    const put = puts().at(-1)!;
    const body = put.body as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["base_rev", "content", "encrypted", "format"]);
    expect(body).toMatchObject({ encrypted: true, format: "html", base_rev: 1 });
    const html = await openEnvelope(body.content as string, { key });
    expect(html).toContain('<h1 id="plan-v2">Plan v2</h1>');
    expect(html).toContain("<title>Plan v2</title>");
    // The key stays here; the token is remembered because the edit worked.
    expect(JSON.stringify(fake.requests)).not.toContain(key);
    expect(await b.pages.get(id)).toEqual({ key, manage: manageTok(manage_url) });

    const got = await call("fmrl_get", { id: url });
    expect(got.structuredContent).toMatchObject({ rev: 2, latest_rev: 2 });
    // The Markdown rides along with the sealed HTML, so the read gives back what was written.
    expect(got.structuredContent).toMatchObject({ content: "# Plan v2\n\nsecond", content_format: "md" });
  });
  it("the owner edits its own private page through its ring, without a manage token and without sealed", async () => {
    const priv = await call("fmrl_publish", { content: "# Mine", private: true });
    const { id, url, manage_url } = priv.structuredContent as { id: string; url: string; manage_url: string };
    // Forget the key publishing remembered, keeping its manage token: the ring opens the page, and the owner has no use for the token.
    await writeFile(pagesFile, JSON.stringify({ version: 1, pages: { [fake.baseUrl]: { [id]: { manage: manageTok(manage_url) } } } }));
    const r = await call("fmrl_edit", { id, content: "# Mine, again", base_rev: 1 });
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent).toEqual({ id, url, rev: 2, watching: true });
    const put = puts().at(-1)!;
    expect(put.manageToken).toBeUndefined();
    expect(put.body).not.toHaveProperty("sealed");
    expect(await openEnvelope((put.body as { content: string }).content, { key: url.split("#p=")[1] })).toContain('<h1 id="mine-again">Mine, again</h1>');
  });
  it("a private page with no key here fails with the sentence, and nothing is sent", async () => {
    const priv = await call("fmrl_publish", { content: "# Sealed", private: true });
    const { id, manage_url } = priv.structuredContent as { id: string; manage_url: string };
    const b = await second();
    const r = await b.call("fmrl_edit", { id, manage_token: manage_url, content: "# Mine now" });
    expect(r.isError).toBe(true);
    expect(text(r)).toBe(PRIVATE_NEEDS_KEY);
    expect(puts()).toHaveLength(0);
    expect(await b.pages.get(id)).toEqual({});
  });
  it("a stale base_rev fails naming the latest revision", async () => {
    const pub = await call("fmrl_publish", { visibility: "public", content: "# One", format: "md" });
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
    const pub = await call("fmrl_publish", { visibility: "public", content: "# P" });
    await call("fmrl_edit", { id: (pub.structuredContent as { id: string }).id, content: "# P2" });
    expect(puts()).toHaveLength(2);
    for (const q of puts()) expect(q.body).not.toHaveProperty("sealed");
  });
  it("refuses blank content before any request", async () => {
    const pub = await call("fmrl_publish", { visibility: "public", content: "# One" });
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
    const bEdit = await b.call("fmrl_edit", { id: `https://fmrl.test/${id}#p=${key}`, manage_token: manage_url, content: "# Plan\n\nv2 by B", base_rev: 1 });
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
    const pub = await call("fmrl_publish", { visibility: "public", content: "# Mine", format: "md" });
    const { id, manage_url } = pub.structuredContent as { id: string; manage_url: string };
    await writeFile(pagesFile, JSON.stringify({ version: 1, pages: {} }));
    const r = await call("fmrl_edit", { id, manage_token: manage_url, content: "# Mine, again", base_rev: 1 });
    expect(r.isError).toBeFalsy();
    expect(puts().at(-1)?.manageToken).toBeUndefined();
    expect(await pagesAt().get(id)).toEqual({});
  });
  it("GET /docs/{id} says whether the caller owns the page", async () => {
    const pub = await call("fmrl_publish", { visibility: "public", content: "# Owned" });
    const id = (pub.structuredContent as { id: string }).id;
    const a = new FmrlApi(fake.baseUrl);
    expect((await a.get(keyOf(firstPublish()), id)).owned).toBe(true);
    const b = new FmrlApi(fake.baseUrl);
    const other = (await b.mint("other")).key;
    expect((await b.get(other, id)).owned).toBe(false);
    expect((await a.list(keyOf(firstPublish()))).docs.every((d) => d.owned === true)).toBe(true);
  });
  it("a refused link token falls back once to the stored one, which stays stored", async () => {
    const pub = await call("fmrl_publish", { visibility: "public", content: "# Shared", format: "md" });
    const { id, manage_url } = pub.structuredContent as { id: string; manage_url: string };
    const b = await second();
    await b.pages.remember(id, { manage: manageTok(manage_url) });
    const forged = "f".repeat(22);
    const r = await b.call("fmrl_edit", { id, manage_token: forged, content: "# By B", base_rev: 1 });
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent).toMatchObject({ rev: 2 });
    expect(puts().map((q) => q.manageToken)).toEqual([forged, manageTok(manage_url)]);
    expect(await b.pages.get(id)).toEqual({ manage: manageTok(manage_url) });
  });
  it("a refused link token with no other stored token fails with the manage-link hint, once", async () => {
    const pub = await call("fmrl_publish", { visibility: "public", content: "# Shared", format: "md" });
    const { id } = pub.structuredContent as { id: string };
    const b = await second();
    const r = await b.call("fmrl_edit", { id, manage_token: "f".repeat(22), content: "# By B" });
    expect(r.isError).toBe(true);
    expect(text(r)).toBe(`To edit, supply https://fmrl.test/${id} as id and its recovery token or /c/<token> link separately as manage_token. Ask whoever shares a recovery link to include the page URL. Recovery grants management, not deletion.`);
    expect(puts()).toHaveLength(1);
    expect(await b.pages.get(id)).toEqual({});
  });
  it("a link token the server accepts replaces a stale stored one", async () => {
    const pub = await call("fmrl_publish", { visibility: "public", content: "# Shared", format: "md" });
    const { id, manage_url } = pub.structuredContent as { id: string; manage_url: string };
    const b = await second();
    await b.pages.remember(id, { manage: "s".repeat(22) });
    const r = await b.call("fmrl_edit", { id, manage_token: manage_url, content: "# By B" });
    expect(r.isError).toBeFalsy();
    expect(puts().map((q) => q.manageToken)).toEqual([manageTok(manage_url)]);
    expect(await b.pages.get(id)).toEqual({ manage: manageTok(manage_url) });
  });
});

describe("fmrl_set_visibility", () => {
  const changes = () => fake.privacyChanges;
  const keyOfUrl = (url: string) => /#p=([A-Za-z0-9_-]{43})$/.exec(url)![1];

  it("makes a public page private under a new key, keeping its id, and fmrl_get opens it with the key it remembered", async () => {
    const pub = await call("fmrl_publish", { visibility: "public", content: "# Plan\n\nShip it." });
    const { id } = pub.structuredContent as { id: string };
    const r = await call("fmrl_set_visibility", { id, visibility: "private" });
    expect(r.isError).toBeFalsy();
    const v = r.structuredContent as { id: string; url: string; visibility: string; changed: boolean };
    expect(v).toMatchObject({ id, visibility: "private", changed: true });
    const key = keyOfUrl(v.url);
    expect(await pagesAt().get(id)).toMatchObject({ key });
    expect(changes().at(-1)).toEqual({ id, to: "private" });
    const put = fake.requests.filter((q) => q.method === "PUT" && q.path === `/api/v1/docs/${id}`).at(-1)!;
    const body = put.body as Record<string, unknown>;
    expect(body).toMatchObject({ change_privacy: true, encrypted: true, format: "html", base_rev: 1 });
    expect(String(body.content)).toMatch(/^MARKYENC/);
    expect(JSON.stringify(body)).not.toContain("Ship it");
    const got = await call("fmrl_get", { id });
    expect(got.structuredContent).toMatchObject({ private: true, content: "# Plan\n\nShip it.", content_format: "md" });
  });

  it("going public answers a preview and changes nothing until confirm: true", async () => {
    const priv = await call("fmrl_publish", { content: "# Notes\n\nFor everyone now." });
    const { id, url } = priv.structuredContent as { id: string; url: string };
    const before = changes().length;
    const first = await call("fmrl_set_visibility", { id: url, visibility: "public" });
    expect(first.isError).toBeFalsy();
    expect(first.structuredContent).toMatchObject({ id, visibility: "public", changed: false, rev: 1, preview: "# Notes\n\nFor everyone now.", content_format: "md" });
    expect(text(first)).toContain("confirm: true and rev: 1 only after they say yes");
    expect(changes().length).toBe(before);
    const second = await call("fmrl_set_visibility", { id: url, visibility: "public", confirm: true, rev: 1 });
    expect(second.structuredContent).toMatchObject({ id, visibility: "public", changed: true, url: `https://fmrl.test/${id}` });
    expect(changes().at(-1)).toEqual({ id, to: "public" });
    const put = fake.requests.filter((q) => q.method === "PUT" && q.path === `/api/v1/docs/${id}`).at(-1)!;
    expect(put.body).toMatchObject({ change_privacy: true, encrypted: false, format: "md", content: "# Notes\n\nFor everyone now.", base_rev: 1 });
  });

  it("a confirm makes public only the revision that was previewed: none named, or a newer one saved since, sends nothing", async () => {
    const priv = await call("fmrl_publish", { content: "# Draft\n\nLooked over." });
    const { id, url } = priv.structuredContent as { id: string; url: string };
    const puts = () => fake.requests.filter((q) => q.method === "PUT" && q.path === `/api/v1/docs/${id}`).length;
    const preview = await call("fmrl_set_visibility", { id: url, visibility: "public" });
    expect(preview.structuredContent).toMatchObject({ rev: 1, changed: false });
    const noRev = await call("fmrl_set_visibility", { id: url, visibility: "public", confirm: true });
    expect(noRev.isError).toBe(true);
    expect(text(noRev)).toContain("confirm: true needs rev");
    const edited = await call("fmrl_edit", { id: url, content: "# Draft\n\nNot looked over." });
    expect(edited.isError).toBeFalsy();
    const before = puts();
    const stale = await call("fmrl_set_visibility", { id: url, visibility: "public", confirm: true, rev: 1 });
    expect(stale.isError).toBe(true);
    expect(text(stale)).toBe("The page changed since the preview: revision 2 is the latest, not 1. Nothing changed. Call again without confirm to preview the latest and show it to the person.");
    expect(puts()).toBe(before);
    expect(changes().filter((c) => c.id === id)).toEqual([]);
  });

  it("going private keeps the page's own title rather than its first heading", async () => {
    const pub = await call("fmrl_publish", { visibility: "public", content: "# Plan\n\nShip it.", title: "Launch notes" });
    const { id } = pub.structuredContent as { id: string };
    const r = await call("fmrl_set_visibility", { id, visibility: "private" });
    expect(r.isError).toBeFalsy();
    const got = await call("fmrl_get", { id });
    expect(got.structuredContent).toMatchObject({ private: true, title: "Launch notes" });
  });

  it("refuses to make public a page that carries a key, before anything is sent", async () => {
    const token = "ghp_" + "aB3dE5gH7jK9mN2pQ4sT6vW8yZ1cF0xL".repeat(2).slice(0, 36);
    const priv = await call("fmrl_publish", { content: `# Deploy\n\n${token}` });
    const { url } = priv.structuredContent as { url: string };
    const before = fake.requests.filter((q) => q.method === "PUT").length;
    const r = await call("fmrl_set_visibility", { id: url, visibility: "public", confirm: true });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("a GitHub token");
    expect(text(r)).not.toContain(token);
    expect(fake.requests.filter((q) => q.method === "PUT").length).toBe(before);
  });

  it("says so, and sends nothing, for the privacy the page already has, a kept page, or a page this key doesn't own", async () => {
    const pub = await call("fmrl_publish", { visibility: "public", content: "# Same" });
    const id = (pub.structuredContent as { id: string }).id;
    const before = fake.requests.filter((q) => q.method === "PUT").length;
    const same = await call("fmrl_set_visibility", { id, visibility: "public" });
    expect(same.isError).toBe(true);
    expect(text(same)).toBe("The page is already public. Nothing changed.");
    const kept = await call("fmrl_publish", { visibility: "public", content: "# Kept", title: "PINNED" });
    const keptRes = await call("fmrl_set_visibility", { id: (kept.structuredContent as { id: string }).id, visibility: "private" });
    expect(text(keptRes)).toContain("A kept page can't change who can read it");
    const other = await agent({ file: "vis" });
    const theirs = await other.call("fmrl_publish", { visibility: "public", content: "# Theirs" });
    const notMine = await call("fmrl_set_visibility", { id: (theirs.structuredContent as { id: string }).id, visibility: "private" });
    expect(text(notMine)).toContain("Only the page's owner can change who can read it");
    expect(fake.requests.filter((q) => q.method === "PUT" && !q.path.endsWith("/watch")).length).toBe(before);
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
    expect(tools.find((t) => t.name === "fmrl_watch")!.description).toBe("Watch a page so revisions other editors make show up in fmrl_inbox. Pass the link you were handed; its key stays on this machine. For a page you read and do not edit: pages you publish or edit are watched already.");
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
    const pub = await call("fmrl_publish", { visibility: "public", content: "# Shared", format: "md" });
    const { id, url, manage_url } = pub.structuredContent as { id: string; url: string; manage_url: string };
    const b = await agent({ file: "b", agentName: "Bee" });
    const edit = await b.call("fmrl_edit", { id, manage_token: manage_url, content: "# Shared, by B", base_rev: 1 });
    expect(edit.isError).toBeFalsy();

    const inbox = await call("fmrl_inbox");
    expect(inbox.isError).toBeFalsy();
    const items = (inbox.structuredContent as { items: Array<Record<string, unknown>> }).items;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ id, url, private: false, status: "live", rev: 2, seen_rev: 1, can_open: true });
    expect(items[0].revisions).toMatchObject([{ rev: 2, editor: { kind: "key", label: "Bee" } }]);
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
    await b.call("fmrl_edit", { id: url, manage_token: manage_url, content: "# Plan v2", base_rev: 1 });
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
    const r = await b.call("fmrl_publish", { visibility: "public", content: "# Still published" });
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
    const c = await connect({ api, keys, pluginRoot, pluginSurface: "claude-cli" });
    try { await fn(c); } finally { await c.close(); }
  };
  const whoami = async (c: Client) => text((await c.callTool({ name: "fmrl_whoami", arguments: {} })) as ToolResult);

  it("startup and whoami keep explicit launcher evidence ahead of a client display name", async () => {
    const api = new FmrlApi(fake.baseUrl);
    const keys = new KeyStore({ api, baseUrl: fake.baseUrl, file: credFile });
    const c = await connect({ api, keys, pluginRoot: await root("0.3.0"), pluginSurface: "claude-desktop" }, "custom-codex-client");
    try {
      expect(c.getInstructions()).toContain("the Claude desktop app's plugin settings");
      const reply = await whoami(c);
      expect(reply).toContain("the Claude desktop app's plugin settings");
      expect(reply).not.toContain("Codex's plugin settings");
    } finally { await c.close(); }
  });
  it.each(["codex", "unknown", "claude-desktop"] as const)("%s receives neutral or matching guidance through MCP", async surface => {
    const api = new FmrlApi(fake.baseUrl);
    const keys = new KeyStore({ api, baseUrl: fake.baseUrl, file: credFile });
    const c = await connect({ api, keys, pluginRoot: await root("0.3.0"), pluginSurface: surface, autoUpdate: { on: false, file: "/s.json" }, offerAutoUpdate: true }, surface);
    try {
      for (const t of [c.getInstructions() ?? "", await whoami(c)]) {
        expect(t).toContain("out of date");
        expect(t).not.toContain("claude plugin");
        expect(t).not.toContain("extraKnownMarketplaces");
        expect(t).not.toContain("Enable auto-update");
      }
    } finally { await c.close(); }
  });
  it("a stale plugin: the instructions raise it and fmrl_whoami says how to fix it", async () => {
    await withRoot(await root("0.3.0"), async (c) => {
      const instructions = c.getInstructions() ?? "";
      expect(instructions.startsWith(`${PREFER_THIS_SERVER}\n\n`)).toBe(true);
      expect(instructions).toContain(`installed 0.3, fmrl-mcp is at ${major}.${minor}`);
      expect(instructions).toContain("claude plugin update fmrl@fmrl-plugin");
      expect(await whoami(c)).toContain(`The fmrl plugin is out of date: installed 0.3, fmrl-mcp is at ${major}.${minor}.`);
    });
  });
  it("a plugin a patch behind: only the preference, and fmrl_whoami says it is up to date", async () => {
    await withRoot(await root(`${major}.${minor}.0`), async (c) => {
      expect(c.getInstructions()).toBe(PREFER_THIS_SERVER);
      expect(await whoami(c)).toContain(`The fmrl plugin is up to date (plugin ${major}.${minor}.0, fmrl-mcp ${VERSION}).`);
    });
  });
  it("no CLAUDE_PLUGIN_ROOT: only the preference and no plugin line", async () => {
    await withRoot(undefined, async (c) => {
      expect(c.getInstructions()).toBe(PREFER_THIS_SERVER);
      expect(await whoami(c)).not.toContain("fmrl plugin");
    });
  });
  it("a malformed plugin.json: only the preference and no plugin line", async () => {
    const r = await mkdtemp(path.join(tmpdir(), "fmrl-plugin-"));
    await mkdir(path.join(r, ".claude-plugin"));
    await writeFile(path.join(r, ".claude-plugin", "plugin.json"), "{ not json");
    await withRoot(r, async (c) => {
      expect(c.getInstructions()).toBe(PREFER_THIS_SERVER);
      expect(await whoami(c)).not.toContain("fmrl plugin");
    });
  });
  it("the other tools' results are unchanged by a stale plugin", async () => {
    await withRoot(await root("0.3.0"), async (c) => {
      const r = (await c.callTool({ name: "fmrl_publish", arguments: { visibility: "public", content: "# hi" } })) as ToolResult;
      expect(text(r)).not.toContain("plugin");
    });
  });
  it("where the auto-update pass cannot run, both the instructions and fmrl_whoami say so", async () => {
    const api = new FmrlApi(fake.baseUrl);
    const keys = new KeyStore({ api, baseUrl: fake.baseUrl, file: path.join(dir, "plugin-creds.json") });
    const autoUpdatePass = { runs: false, desktop: true, by: "DISABLE_AUTOUPDATER" };
    const c = await connect({ api, keys, pluginRoot: await root("0.3.0"), autoUpdate: { on: true, file: "/s.json" }, autoUpdatePass, pluginSurface: "claude-cli" });
    try {
      expect(c.getInstructions()).toContain("Auto-update cannot run here (the Claude desktop app disables it)");
      const me = await whoami(c);
      expect(me).toContain("Auto-update does not run in the Claude desktop app");
      expect(me).not.toContain("Auto-update is on");
    } finally {
      await c.close();
    }
  });

  /** strings is every string value in a structured answer, however deep. */
  const strings = (v: unknown): string[] =>
    typeof v === "string" ? [v] : Array.isArray(v) ? v.flatMap(strings) : v && typeof v === "object" ? Object.values(v).flatMap(strings) : [];

  it("puts the ring, the plugin and a newer installed plugin in whoami's structured answer, not only its text (#23)", async () => {
    // A cache with this session's plugin and a newer one beside it, as Claude Code keeps them.
    const cacheDir = await mkdtemp(path.join(tmpdir(), "fmrl-cache-"));
    for (const v of ["0.3.0", "9.9.9"]) {
      await mkdir(path.join(cacheDir, v, ".claude-plugin"), { recursive: true });
      await writeFile(path.join(cacheDir, v, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "fmrl", version: v }));
    }
    const api = new FmrlApi(fake.baseUrl);
    const file = path.join(dir, "plugin-creds.json");
    const keys = new KeyStore({ api, baseUrl: fake.baseUrl, file });
    const c = await connect({ api, keys, pluginRoot: path.join(cacheDir, "0.3.0"), autoUpdate: { on: false, file: "/s.json" }, pluginSurface: "claude-cli" });
    try {
      const r = (await c.callTool({ name: "fmrl_whoami", arguments: {} })) as ToolResult;
      expect(r.isError).toBeFalsy();
      const s = r.structuredContent as Record<string, any>;
      expect(s.ring).toEqual({ kept_in: "file", file, note: RING_FILE_LINE(file) });
      expect(s.plugin).toMatchObject({ installed: "0.3.0", server: VERSION, stale: true, auto_update: "off", newer_installed: "9.9.9" });
      expect(s.plugin.note).toContain("Plugin 9.9.9 is already installed, but this session started on 0.3.0: restart Claude Code to load it.");
      // Every line past the key's own facts reaches a client that reads only the structured half.
      const reachable = strings(s);
      const lines = text(r).split("\n");
      const tail = lines.slice(lines.indexOf(RING_FILE_LINE(file)));
      expect(tail.length).toBeGreaterThan(1);
      for (const line of tail) expect(reachable).toContain(line);
      expect(text(r)).toContain("Plugin 9.9.9 is already installed");
    } finally {
      await c.close();
    }
  });

  it("leaves plugin out of whoami's structured answer when no manifest is readable", async () => {
    await withRoot(undefined, async (c) => {
      const r = (await c.callTool({ name: "fmrl_whoami", arguments: {} })) as ToolResult;
      expect(r.isError).toBeFalsy();
      expect(r.structuredContent).not.toHaveProperty("plugin");
      expect(r.structuredContent).toHaveProperty("ring.kept_in", "file");
    });
  });
});

describe("key codes, rotation and revocation", () => {
  const stored = async () => (await readCredentials(credFile)).keys[fake.baseUrl];
  const mints = () => fake.requests.filter((q) => q.path === "/api/v1/keys").length;
  /** envClient is a server whose key comes from FMRL_API_KEY. */
  const envClient = (key: string) => {
    const api2 = new FmrlApi(fake.baseUrl);
    return connect({ api: api2, keys: new KeyStore({ api: api2, baseUrl: fake.baseUrl, file: path.join(dir, "env.json"), apiKeyFromEnv: key }) });
  };

  it("fmrl_redeem trades the code for this machine's rotated key, keeps its ring, and uses it from then on", async () => {
    await call("fmrl_whoami");
    const before = await stored();
    const prefix = before.prefix;
    const code = fake.handoff(before.key);
    const r = await call("fmrl_redeem", { code: ` ${code.toLowerCase()} ` });
    expect(r.isError).toBeFalsy();
    const after = await stored();
    expect(after).toEqual({ ...before, key: expect.not.stringMatching(before.key) });
    expect(fake.keys.has(after.key)).toBe(true);
    expect(fake.requests.at(-1)).toMatchObject({ path: "/api/v1/keys/redeem", auth: undefined, body: { code: code.replace(/-/g, "") } });
    expect(text(r)).toBe(`Redeemed the key code for ${prefix}…, this machine's key: its new secret is saved to ${credFile}. Its pages, name, linked browsers and key ring carry over.`);
    expect(text(r)).not.toContain(after.key);
    expect(r.structuredContent).toEqual({ prefix, file: credFile });
    const pub = await call("fmrl_publish", { visibility: "public", content: "# after" });
    expect(pub.isError).toBeFalsy();
    expect(keyOf(firstPublish())).toBe(after.key);
    expect(mints()).toBe(1);
  });
  it("fmrl_redeem for another key replaces the stored one, and a ring filed under the new prefix still applies", async () => {
    const other = await new FmrlApi(fake.baseUrl).mint("elsewhere");
    const ringA = newRing();
    const ringB = newRing();
    await writeCredentials(credFile, {
      version: 1,
      keys: { [fake.baseUrl]: { key: "fmrl_OLD1" + "o".repeat(28), prefix: "fmrl_OLD1", created_at: "t", ring: ringA } },
      rings: { [other.prefix]: ringB },
    });
    const r = await call("fmrl_redeem", { code: fake.handoff(other.key) });
    expect(r.isError).toBeFalsy();
    expect(text(r)).toBe(`Redeemed the key code: this machine now uses ${other.prefix}…, saved to ${credFile}. It replaces fmrl_OLD1…, whose key ring stays in that file.`);
    expect(r.structuredContent).toEqual({ prefix: other.prefix, file: credFile, replaced: "fmrl_OLD1" });
    const file = await readCredentials(credFile);
    expect(file.keys[fake.baseUrl]).toEqual({ key: expect.not.stringMatching(new RegExp(`^${other.prefix}`)), prefix: other.prefix });
    expect(fake.prefixOf(file.keys[fake.baseUrl].key)).toBe(other.prefix);
    expect(file.rings).toEqual({ fmrl_OLD1: ringA, [other.prefix]: ringB });
    const who = await call("fmrl_whoami");
    expect(RING_PAIR.exec((who.structuredContent as { attach_url: string }).attach_url)!.slice(1)).toEqual([other.prefix, ringB]);
  });
  it("fmrl_redeem refuses something that isn't a key code without sending it", async () => {
    const r = await call("fmrl_redeem", { code: "K7QX-M2PA-9D4R-TW6B-H3NC-EY" });
    expect(r.isError).toBe(true);
    expect(text(r)).toBe("That isn't a key code: a key code is 26 letters and digits 2–7, shown in groups of four like K7QX-M2PA-…. Nothing was sent.");
    expect(fake.requests).toHaveLength(0);
  });
  it("fmrl_redeem reports a spent code and keeps the stored key", async () => {
    await call("fmrl_whoami");
    const code = fake.handoff((await stored()).key);
    await call("fmrl_redeem", { code });
    const kept = await stored();
    const r = await call("fmrl_redeem", { code });
    expect(r.isError).toBe(true);
    expect(text(r)).toBe("That key code has expired or was already used. Rotate again from your keys page.");
    expect(await stored()).toEqual(kept);
  });
  it("fmrl_redeem with FMRL_API_KEY set refuses without spending the code", async () => {
    const { key } = await new FmrlApi(fake.baseUrl).mint("env");
    const code = fake.handoff(key);
    const c = await envClient(key);
    try {
      const r = (await c.callTool({ name: "fmrl_redeem", arguments: { code } })) as ToolResult;
      expect(r.isError).toBe(true);
      expect(text(r)).toBe("FMRL_API_KEY sets this machine's key, so fmrl-mcp won't replace it, and the code is still unspent. Unset FMRL_API_KEY and redeem it again, or trade it yourself with POST /api/v1/keys/redeem and set FMRL_API_KEY to the key it returns.");
      expect(fake.requests.some((q) => q.path === "/api/v1/keys/redeem")).toBe(false);
      await expect(new FmrlApi(fake.baseUrl).redeem(code)).resolves.toMatchObject({ prefix: key.slice(0, 9) });
    } finally {
      await c.close();
    }
  });
  it("fmrl_redeem that can't save the key hands it over and keeps using it", async () => {
    const { key } = await new FmrlApi(fake.baseUrl).mint("elsewhere");
    const blocked = path.join(dir, "blocked");
    await writeFile(blocked, "not a directory");
    const api2 = new FmrlApi(fake.baseUrl);
    const file = path.join(blocked, "credentials.json");
    const c = await connect({ api: api2, keys: new KeyStore({ api: api2, baseUrl: fake.baseUrl, file }) });
    try {
      const r = (await c.callTool({ name: "fmrl_redeem", arguments: { code: fake.handoff(key) } })) as ToolResult;
      expect(r.isError).toBe(true);
      const fresh = [...fake.keys].find((k) => fake.prefixOf(k) === key.slice(0, 9))!;
      expect(text(r)).toMatch(new RegExp(`^Redeemed the key code for ${key.slice(0, 9)}…, but couldn't save it to ${file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\(.+\\); this session uses it until it ends\\. The code is spent and fmrl\\.site keeps only a hash of the key, so save it now, or set FMRL_API_KEY to it: ${fresh}$`));
      const pub = (await c.callTool({ name: "fmrl_publish", arguments: { visibility: "public", content: "# still works" } })) as ToolResult;
      expect(pub.isError).toBeFalsy();
      expect(keyOf(fake.requests.filter((q) => q.path === "/api/v1/publish").at(-1)!)).toBe(fresh);
    } finally {
      await c.close();
    }
  });

  it("fmrl_rotate replaces the secret, saves the new key with its ring, and fmrl_whoami then shows when", async () => {
    await call("fmrl_whoami");
    expect(text(await call("fmrl_whoami"))).not.toContain("rotated");
    const before = await stored();
    const r = await call("fmrl_rotate");
    expect(r.isError).toBeFalsy();
    const after = await stored();
    const rotatedAt = (r.structuredContent as { rotated_at: string }).rotated_at;
    expect(r.structuredContent).toEqual({ prefix: before.prefix, rotated_at: rotatedAt, file: credFile });
    expect(fake.requests.at(-1)).toMatchObject({ path: "/api/v1/me/rotate", auth: `Bearer ${before.key}` });
    expect(after).toEqual({ ...before, key: expect.not.stringMatching(before.key) });
    expect(fake.keys.has(before.key)).toBe(false);
    expect(fake.keys.has(after.key)).toBe(true);
    expect(text(r)).toBe(`Rotated ${before.prefix}… at ${rotatedAt}: the old secret stopped working, and the new one is saved to ${credFile}. Its pages, name, quota, linked browsers, connected apps and key ring carry over.`);
    expect(text(r)).not.toContain(after.key);
    const who = await call("fmrl_whoami");
    expect(text(who)).toContain(`Last rotated ${rotatedAt}.`);
    expect(who.structuredContent).toMatchObject({ rotated_at: rotatedAt });
    expect(mints()).toBe(1);
  });
  it("after fmrl_rotate, private pages still open under the same ring, and links pair that ring with the key's prefix, not the new secret's", async () => {
    const priv = await call("fmrl_publish", { content: "# Quiet\n\nhello", private: true });
    const { id } = priv.structuredContent as { id: string };
    const before = await stored();
    const r = await call("fmrl_rotate");
    expect(r.isError).toBeFalsy();
    const after = await stored();
    // The server mints the secret afresh: only the record keeps the prefix.
    expect(after.key.slice(0, 9)).not.toBe(before.prefix);
    expect(after).toEqual({ ...before, key: after.key });
    const got = await call("fmrl_get", { id });
    expect(got.structuredContent).toMatchObject({ id, key_held: true, title: "Quiet" });
    const who = await call("fmrl_whoami");
    expect(RING_PAIR.exec((who.structuredContent as { attach_url: string }).attach_url)!.slice(1)).toEqual([before.prefix, before.ring]);
    const more = await call("fmrl_publish", { content: "# More", private: true });
    expect(RING_PAIR.exec((more.structuredContent as { attach_url: string }).attach_url)!.slice(1)).toEqual([before.prefix, before.ring]);
    expect((await readCredentials(credFile)).rings).toBeUndefined();
    expect(mints()).toBe(1);
  });
  it("fmrl_rotate after another process rotated the key rotates that key, and mints nothing", async () => {
    await call("fmrl_whoami");
    const before = await stored();
    const theirs = await new FmrlApi(fake.baseUrl).rotate(before.key);
    await new KeyStore({ api: new FmrlApi(fake.baseUrl), baseUrl: fake.baseUrl, file: credFile }).adopt(theirs.key, theirs.prefix);
    const r = await call("fmrl_rotate");
    expect(r.isError).toBeFalsy();
    expect(fake.requests.at(-1)).toMatchObject({ path: "/api/v1/me/rotate", auth: `Bearer ${theirs.key}` });
    expect(await stored()).toEqual({ ...before, key: expect.not.stringMatching(theirs.key) });
    expect(fake.keys.has(theirs.key)).toBe(false);
    expect(mints()).toBe(1);
  });
  it("fmrl_rotate says when it replaces a different key that another process stored", async () => {
    await call("fmrl_whoami");
    const before = await stored();
    const other = await new FmrlApi(fake.baseUrl).mint("elsewhere");
    await new KeyStore({ api: new FmrlApi(fake.baseUrl), baseUrl: fake.baseUrl, file: credFile }).adopt(other.key, other.prefix);
    const r = await call("fmrl_rotate");
    expect(r.isError).toBeFalsy();
    expect(text(r)).toContain(`It replaces ${other.prefix}…, whose key ring stays in that file.`);
    expect(r.structuredContent).toMatchObject({ prefix: before.prefix, replaced: other.prefix });
  });
  it("fmrl_rotate with FMRL_API_KEY set refuses without rotating", async () => {
    const { key } = await new FmrlApi(fake.baseUrl).mint("env");
    const c = await envClient(key);
    try {
      const r = (await c.callTool({ name: "fmrl_rotate", arguments: {} })) as ToolResult;
      expect(r.isError).toBe(true);
      expect(text(r)).toBe("FMRL_API_KEY sets this machine's key, so fmrl-mcp won't rotate it: the new key could not reach FMRL_API_KEY. Rotate it with POST /api/v1/me/rotate and set FMRL_API_KEY to the key it returns.");
      expect(fake.requests.some((q) => q.path === "/api/v1/me/rotate")).toBe(false);
    } finally {
      await c.close();
    }
  });
  it("fmrl_rotate with no key yet refuses rather than mint one to rotate", async () => {
    const r = await call("fmrl_rotate");
    expect(r.isError).toBe(true);
    expect(text(r)).toBe("There is no fmrl key on this machine yet, so there is nothing to rotate. The first fmrl tool that needs one makes it.");
    expect(fake.requests).toHaveLength(0);
  });
  it("fmrl_rotate on a revoked key says so and mints nothing", async () => {
    await call("fmrl_whoami");
    const before = await stored();
    fake.revoked.add(before.key);
    const r = await call("fmrl_rotate");
    expect(r.isError).toBe(true);
    expect(text(r)).toContain(`${before.prefix}… was revoked, so it will not work again.`);
    expect(mints()).toBe(1);
  });

  it("fmrl_whoami on a revoked stored key says so and how to get a new one, and replaces nothing", async () => {
    await call("fmrl_whoami");
    const before = await stored();
    fake.revoked.add(before.key);
    const r = await call("fmrl_whoami");
    expect(r.isError).toBe(true);
    expect(text(r)).toBe(`${before.prefix}… was revoked, so it will not work again. The next fmrl tool that needs a key (fmrl_publish, fmrl_list and the rest) makes a new one and saves it to ${credFile}; the revoked key's ring stays in that file.`);
    expect(await stored()).toEqual(before);
    expect(mints()).toBe(1);
    // As it says: the next publish replaces the key, and the old ring stays under its prefix.
    const pub = await call("fmrl_publish", { visibility: "public", content: "# new key" });
    expect(pub.isError).toBeFalsy();
    expect(mints()).toBe(2);
    expect((await readCredentials(credFile)).rings).toEqual({ [before.prefix]: before.ring });
  });
  it("fmrl_whoami on a revoked FMRL_API_KEY says how to make a new one", async () => {
    const { key } = await new FmrlApi(fake.baseUrl).mint("env");
    fake.revoked.add(key);
    const c = await envClient(key);
    try {
      const r = (await c.callTool({ name: "fmrl_whoami", arguments: {} })) as ToolResult;
      expect(r.isError).toBe(true);
      expect(text(r)).toBe(`${key.slice(0, 9)}… (from FMRL_API_KEY) was revoked, so it will not work again. Unset FMRL_API_KEY and fmrl-mcp uses the key saved in ${path.join(dir, "env.json")}, making one there if there is none, or set FMRL_API_KEY to a new key from POST /api/v1/keys.`);
    } finally {
      await c.close();
    }
  });
});

describe("fmrl_status", () => {
  /** cache lays out a plugin cache directory with one manifest per version and answers the root for `started`, the way CLAUDE_PLUGIN_ROOT names it. */
  const cache = async (versions: string[], started: string): Promise<string> => {
    const dir = await mkdtemp(path.join(tmpdir(), "fmrl-cache-"));
    for (const v of versions) {
      await mkdir(path.join(dir, v, ".claude-plugin"), { recursive: true });
      await writeFile(path.join(dir, v, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "fmrl", version: v }));
    }
    return path.join(dir, started);
  };
  const [major, minor] = VERSION.split(".");
  const current = `${major}.${minor}.0`;
  const status = async (c: Client, args: Record<string, unknown> = {}) => text((await c.callTool({ name: "fmrl_status", arguments: args })) as ToolResult);
  const withDeps = async (extra: Partial<ServerDeps>, fn: (c: Client) => Promise<void>, api = new FmrlApi(fake.baseUrl)) => {
    const keys = new KeyStore({ api, baseUrl: fake.baseUrl, file: credFile });
    const c = await connect({ api, keys, ...extra });
    try { await fn(c); } finally { await c.close(); }
  };

  it("answers from local state alone: no request, no key minted, nothing written, text only", async () => {
    const r = await call("fmrl_status");
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent).toBeUndefined();
    expect(fake.requests).toHaveLength(0);
    expect((await readCredentials(credFile)).keys).toEqual({});
    const lines = text(r).split("\n");
    expect(lines).toHaveLength(5);
    expect(lines[0]).toMatch(new RegExp(`^fmrl-mcp ${VERSION.replace(/\./g, "\\.")}, up \\d+ s, launched by test 0\\.$`));
    expect(lines[1]).toBe(NO_PLUGIN_LINE);
    expect(lines[2]).toBe(`API ${fake.baseUrl}: no key yet, the first publish mints one (nothing was minted now); no pages remembered.`);
    expect(lines[3]).toBe("No API call yet this session.");
    expect(lines[4]).toBe(VERBOSE_HINT);
  });
  it("describes the key, its ring, the pages remembered and the last call once other tools have run", async () => {
    const pub = await call("fmrl_publish", { visibility: "public", content: "# Hello" });
    // A publish ends with the vault sync's own calls, so read the page back: the last call is then the read, with its id blanked.
    await call("fmrl_get", { id: (pub.structuredContent as { id: string }).id });
    const n = fake.requests.length;
    const t = text(await call("fmrl_status"));
    expect(fake.requests).toHaveLength(n);
    expect(t).toMatch(/^API .*: key fmrl_[A-Za-z0-9]{4}… from .*credentials\.json, minted 2026-09-08; key ring in that file; 1 page remembered\.$/m);
    expect(t).toMatch(/^Last call: GET \/docs\/…\/revisions\/1 → 200 in \d+ ms, just now\.$/m);
  });
  it("carries the plugin line, names the launcher, and says when a newer plugin is already installed beside this session's", async () => {
    await withDeps({ pluginRoot: await cache([current], current), pluginSurface: "claude-cli" }, async (c) => {
      const t = await status(c);
      expect(t).toContain("launched by extra 0 (Claude Code CLI).");
      expect(t).toContain(`The fmrl plugin is up to date (plugin ${current}, fmrl-mcp ${VERSION}).`);
      expect(t).not.toContain("already installed");
    });
    await withDeps({ pluginRoot: await cache(["0.3.0", "9.9.9"], "0.3.0"), pluginSurface: "claude-cli" }, async (c) => {
      const t = await status(c);
      expect(t).toContain(`The fmrl plugin is out of date: installed 0.3, fmrl-mcp is at ${major}.${minor}.`);
      expect(t).toContain("Plugin 9.9.9 is already installed, but this session started on 0.3.0: restart Claude Code to load it.");
    });
    await withDeps({ pluginRoot: "/nonexistent/fmrl/0.1.0" }, async (c) => {
      expect(await status(c)).toContain("Plugin: manifest unreadable under /nonexistent/fmrl/0.1.0.");
    });
  });
  describe("verbose", () => {
    it("asks fmrl.site and npm, in a bounded time, and never names or replaces the key", async () => {
      let asked = 0;
      await withDeps({ latestOnNpm: async () => { asked++; return "9.9.9"; } }, async (c) => {
        const pub = (await c.callTool({ name: "fmrl_publish", arguments: { visibility: "public", content: "# Hello" } })) as ToolResult;
        await c.callTool({ name: "fmrl_get", arguments: { id: (pub.structuredContent as { id: string }).id } });
        const n = fake.requests.length;
        const t = await status(c, { verbose: true });
        expect(fake.requests.slice(n).map((q) => `${q.method} ${q.path}`)).toEqual(["GET /api/v1/me", "GET /api/v1/inbox"]);
        expect(t).toMatch(/^fmrl\.site|^http:\/\/127\.0\.0\.1:\d+: reachable, \d+ ms\. Quota: 1 of 25 publishes used this month, resets 2026-10-01T00:00:00Z\. Agent not attached, so its canvases don't show on fmrl\.site; fmrl_whoami says how to attach it\. Inbox: empty\.$/m);
        expect(t).toContain(`npm: fmrl-mcp 9.9.9 is the latest; this session runs ${VERSION}, so restart the client that started it to pick it up.`);
        expect(asked).toBe(1);
        // The probes are not the user's calls: the last call is still the read.
        expect(await status(c)).toMatch(/^Last call: GET \/docs\/…\/revisions\/1 → 200 in \d+ ms, just now\.$/m);
      });
    });
    it("probes without a key rather than minting one", async () => {
      await withDeps({ latestOnNpm: async () => VERSION }, async (c) => {
        const t = await status(c, { verbose: true });
        expect(fake.requests.map((q) => `${q.method} ${q.path} ${q.auth ?? "-"}`)).toEqual(["GET /api/v1/me -"]);
        expect((await readCredentials(credFile)).keys).toEqual({});
        expect(t).toMatch(/: reachable, \d+ ms \(answered 401 without a key, as expected\)\.$/m);
        expect(t).toContain(`npm: fmrl-mcp ${VERSION} is the latest.`);
      });
    });
    it("reports a refused key without replacing it", async () => {
      await withDeps({ latestOnNpm: async () => VERSION }, async (c) => {
        await c.callTool({ name: "fmrl_publish", arguments: { visibility: "public", content: "# Hello" } });
        const key = keyOf(firstPublish());
        fake.revoked.add(key);
        const t = await status(c, { verbose: true });
        expect(t).toMatch(/: reachable, \d+ ms, but it refused key fmrl_[A-Za-z0-9]{4}… \(key_revoked\); nothing was replaced\. fmrl_whoami says how to get a new one\.$/m);
        expect((await readCredentials(credFile)).keys[fake.baseUrl].key).toBe(key);
        expect(fake.requests.filter((q) => q.path === "/api/v1/keys")).toHaveLength(1);
      });
    });
    it("skips npm where nonessential traffic is off, and says when npm did not answer", async () => {
      let asked = 0;
      await withDeps({ nonessentialTrafficOff: true, latestOnNpm: async () => { asked++; return "9.9.9"; } }, async (c) => {
        expect(await status(c, { verbose: true })).toContain("npm: not checked (CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC is set).");
        expect(asked).toBe(0);
      });
      await withDeps({ latestOnNpm: async () => { throw new Error("No answer from the npm registry within 3 s."); } }, async (c) => {
        expect(await status(c, { verbose: true })).toContain("npm: not reached (No answer from the npm registry within 3 s.).");
      });
    });
    it("says fmrl.site is unreachable, and gives up on an API that hangs within the bound", async () => {
      await withDeps({ latestOnNpm: async () => VERSION }, async (c) => {
        expect(await status(c, { verbose: true })).toMatch(/^http:\/\/127\.0\.0\.1:1: unreachable \(Couldn't reach http:\/\/127\.0\.0\.1:1\/api\/v1: .*\)\.$/m);
      }, new FmrlApi("http://127.0.0.1:1"));
      await withDeps({ latestOnNpm: async () => VERSION, probeTimeoutMs: 50 }, async (c) => {
        const t0 = Date.now();
        const t = await status(c, { verbose: true });
        expect(Date.now() - t0).toBeLessThan(2_000);
        expect(t).toMatch(/: unreachable \(No answer from http:\/\/127\.0\.0\.1:\d+\/api\/v1 within 0\.05s\.\)\.$/m);
        // The hung probe was aborted, not left to land in lastCall later.
        expect(await status(c)).toContain("No API call yet this session.");
      }, new FmrlApi(fake.baseUrl, { fetchImpl: hangingFetch }));
    });
  });
});

describe("machineName", () => {
  it("is the host name's first label, cut to 40 characters", () => {
    expect(machineName("Prodigal.local")).toBe("Prodigal");
    expect(machineName("homebase")).toBe("homebase");
    expect(machineName("a".repeat(50))).toBe("a".repeat(40));
  });
});
