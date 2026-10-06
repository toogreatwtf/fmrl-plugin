import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createECDH } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, FmrlApi, type AccountVault } from "../src/api.js";
import { readCredentials, writeCredentials } from "../src/credentials.js";
import { KeyStore } from "../src/keys.js";
import { vaultFingerprint } from "../src/vault-crypto.js";
import fx from "./fixtures/vault.json";
import { openTestVaultBox } from "./support/vault.js";
import { startFakeApi, type FakeApi } from "./fake-api.js";
import type { CredentialsFile } from "../src/credentials.js";
import { newRing } from "../src/crypto.js";
import { batchVaultRings, collectVaultRings, VaultSync } from "../src/vault-sync.js";

const baseUrl = "https://fmrl.site/api";

describe("collectVaultRings", () => {
  it("keeps each historical variant in numeric order and sends the active ring last", () => {
    const rings = [newRing(), newRing(), newRing(), newRing()];
    const file: CredentialsFile = { version: 1, keys: {
      [baseUrl]: { key: "fmrl_test" + "x".repeat(28), prefix: "fmrl_test", ring: rings[3] },
    }, rings: { "fmrl_test.10": rings[2], "fmrl_test.2": rings[1], fmrl_test: rings[0] },
      ring_origins: { "fmrl_test.10": "https://fmrl.site", "fmrl_test.2": "https://fmrl.site", fmrl_test: "https://fmrl.site" } };
    const list = collectVaultRings(file, baseUrl);
    expect(list).toEqual(rings.map(ring => ({ prefix: "fmrl_test", ring })));
    expect(batchVaultRings(list)).toEqual(list.map(row => [row]));
  });
  it("allows canonical origin aliases and exact legacy pairs, excluding foreign and unknown history", () => {
    const active = newRing(); const alias = newRing(); const unknown = newRing();
    const file: CredentialsFile = { version: 1, keys: {
      [baseUrl]: { key: "fmrl_test", prefix: "fmrl_test", ring: active },
      "https://FMRL.site:443/other": { key: "fmrl_alia", prefix: "fmrl_alia", ring: alias },
      "https://preview.fmrl.site": { key: "fmrl_prev", prefix: "fmrl_prev", ring: unknown },
    }, rings: { fmrl_test: active, "fmrl_test.2": unknown, fmrl_old1: unknown },
      ring_origins: { fmrl_old1: "https://fmrl.site" } };
    expect(collectVaultRings(file, baseUrl)).toEqual([
      { prefix: "fmrl_old1", ring: unknown }, { prefix: "fmrl_alia", ring: alias }, { prefix: "fmrl_test", ring: active },
    ]);
  });
  it("ignores malformed prefixes and noncanonical rings, stripping only valid terminal variant suffixes", () => {
    const ring = newRing();
    const file = { version: 1, keys: {
      [baseUrl]: { key: "fmrl_test" + "x".repeat(28), prefix: "fmrl_bad_", ring },
      "https://bad-key.site": { key: 7, ring },
      "https://bad-ring.site": { key: "fmrl_test", ring: "B".repeat(43) },
      "https://bad-prefix.site": { key: "fmrl_test", prefix: 7, ring },
    }, rings: {
      "fmrl_good.2": ring, "fmrl_long.123": ring, "fmrl_Ab12": ring,
      "fmrl_test.1": ring, "fmrl_test.02": ring, "fmrl_test.2.3": ring,
      "fmrl_test.0": ring, "fmrl_test.-2": ring, fmrl_bad_: ring,
      fmrl_test: "B".repeat(43), fmrl_num1: 7, "fmrl_evil\n": ring,
    }, ring_origins: { "fmrl_good.2": "https://fmrl.site", "fmrl_long.123": "https://fmrl.site", fmrl_Ab12: "https://fmrl.site" } } as unknown as CredentialsFile;
    expect(collectVaultRings(file, baseUrl)).toEqual([
      { prefix: "fmrl_Ab12", ring }, { prefix: "fmrl_good", ring }, { prefix: "fmrl_long", ring },
    ]);
  });
  it("returns only credential-file rings, including when no configured key is stored", () => {
    const ring = newRing();
    expect(collectVaultRings({ version: 1, keys: {}, rings: { fmrl_test: ring }, ring_origins: { fmrl_test: "https://fmrl.site" } }, baseUrl))
      .toEqual([{ prefix: "fmrl_test", ring }]);
    expect(collectVaultRings({ version: 1, keys: {} }, baseUrl)).toEqual([]);
  });
});

describe("batchVaultRings", () => {
  it("splits 51 unique prefixes without dropping rows and sends one empty batch", () => {
    const rows = Array.from({ length: 51 }, (_, n) => ({ prefix: `fmrl_${String(n).padStart(4, "0")}`, ring: newRing() }));
    const batches = batchVaultRings(rows);
    expect(batches.map(b => b.length)).toEqual([50, 1]);
    expect(batches.flat()).toEqual(rows);
    expect(batchVaultRings([])).toEqual([[]]);
    expect(rows).toHaveLength(51);
  });
  it("starts a new batch on any repeated prefix while preserving upload order", () => {
    const rows = ["fmrl_aaaa", "fmrl_bbbb", "fmrl_aaaa", "fmrl_aaaa", "fmrl_cccc"].map(prefix => ({ prefix, ring: newRing() }));
    const batches = batchVaultRings(rows);
    expect(batches).toEqual([rows.slice(0, 2), rows.slice(2, 3), rows.slice(3)]);
    for (const batch of batches) expect(new Set(batch.map(row => row.prefix)).size).toBe(batch.length);
    expect(batches.flat()).toEqual(rows);
  });
});

describe("VaultSync", () => {
  let fake: FakeApi; let api: FmrlApi; let keys: KeyStore; let sync: VaultSync;
  let dir: string; let file: string; let key: string; let active: string; let logs: string[];
  const advertised = { pub: fx.pub, fingerprint: fx.fingerprint };
  beforeEach(async () => {
    fake = await startFakeApi(); api = new FmrlApi(fake.baseUrl);
    key = (await api.mint("x")).key;
    dir = await mkdtemp(path.join(tmpdir(), "fmrl-vault-sync-")); file = path.join(dir, "credentials.json");
    active = newRing(); logs = [];
    await writeCredentials(file, { version: 1, keys: {
      [fake.baseUrl]: { key, prefix: fx.prefix, ring: active },
    }, rings: { [fx.prefix]: fx.ring } });
    keys = new KeyStore({ api, baseUrl: fake.baseUrl, file });
    sync = new VaultSync({ api, keys, log: line => logs.push(line) });
    fake.accountVaults.set(key, advertised); fake.ringClaims.set(key, new Set([fx.prefix])); fake.requests.length = 0;
  });
  afterEach(async () => { vi.restoreAllMocks(); await fake.close(); await rm(dir, { recursive: true, force: true }); });
  const replacement = (): AccountVault => {
    const ec = createECDH("prime256v1"); ec.generateKeys(); const pub = ec.getPublicKey().toString("base64url");
    return { pub, fingerprint: vaultFingerprint(pub) };
  };
  const puts = (): number => fake.requests.filter(q => q.path === "/api/v1/me/rings").length;
  const expectFixedLog = (): void => { expect(logs).toEqual(["fmrl-mcp: vault sync failed"]); };

  it("never seals production or unscoped legacy rings to a fresh preview vault", async () => {
    const production = newRing(); const legacy = newRing();
    const credentials: CredentialsFile = { version: 1, keys: {
      "https://fmrl.site": { key: "fmrl_PROD" + "x".repeat(28), prefix: "fmrl_PROD", ring: production },
      [fake.baseUrl]: { key, prefix: fx.prefix, ring: active },
    }, rings: { fmrl_OLD1: legacy } };
    await writeCredentials(file, credentials);
    // Malicious preview claims all prefixes. Its first-use vault key must still learn only its ring.
    fake.ringClaims.set(key, new Set([fx.prefix, "fmrl_PROD", "fmrl_OLD1"]));
    await sync.sync(key);
    const captured = fake.requests.filter(q => q.path === "/api/v1/me/rings")
      .flatMap(q => (q.body as { boxes: { prefix: string; box: string }[] }).boxes)
      .map(row => openTestVaultBox(fx, row.prefix, row.box));
    expect(captured).toEqual([active]);
    expect((await readCredentials(file)).rings).toEqual(credentials.rings);
    expect((await readCredentials(file)).keys["https://fmrl.site"].ring).toBe(production);
  });
  it("uploads the active claimed prefix despite mixed claimed and unclaimed local history", async () => {
    const rings = { fmrl_0000: newRing(), fmrl_0001: newRing() };
    await writeCredentials(file, { version: 1, keys: { [fake.baseUrl]: { key, prefix: fx.prefix, ring: active } },
      rings, ring_origins: Object.fromEntries(Object.keys(rings).map(p => [p, fake.baseUrl])) } as CredentialsFile);
    fake.ringClaims.set(key, new Set([fx.prefix, "fmrl_0001"]));
    expect(await sync.sync(key)).toMatchObject({ state: "unknown" });
    expect(fake.ringBoxes.has(fx.prefix)).toBe(true);
    expect(openTestVaultBox(fx, fx.prefix, fake.ringBoxes.get(fx.prefix)!)).toBe(active);
    expect(openTestVaultBox(fx, "fmrl_0001", fake.ringBoxes.get("fmrl_0001")!)).toBe(rings.fmrl_0001);
    expect(fake.ringBoxes.has("fmrl_0000")).toBe(false);
    expect((fake.requests.find(q => q.path === "/api/v1/me/rings")!.body as { boxes: { prefix: string }[] }).boxes[0].prefix).toBe(fx.prefix);
    const before = puts(); await sync.sync(key); expect(puts()).toBeGreaterThan(before);
  });
  it("prioritizes active prefix before historical requests consume the edit budget", async () => {
    const rings = { ...Object.fromEntries(Array.from({ length: 70 }, (_, n) => [`${fx.prefix}.${n + 2}`, newRing()])), fmrl_0000: newRing() };
    await writeCredentials(file, { version: 1, keys: { [fake.baseUrl]: { key, prefix: fx.prefix, ring: active } },
      rings, ring_origins: Object.fromEntries(Object.keys(rings).map(p => [p, fake.baseUrl])) } as CredentialsFile);
    const original = api.putRings.bind(api); let calls = 0;
    vi.spyOn(api, "putRings").mockImplementation(async (...args) => {
      if (++calls === 2) throw new ApiError(429, "rate_limit", "");
      return original(...args);
    });
    expect(await sync.sync(key)).toMatchObject({ state: "unknown" });
    expect(fake.ringBoxes.has(fx.prefix)).toBe(true);
    expect(openTestVaultBox(fx, fx.prefix, fake.ringBoxes.get(fx.prefix)!)).toBe(active);
    expect(calls).toBe(2);
  });
  it.each([429, 500, 0])("stops singleton fallback immediately on operational failure %s", async status => {
    const rings = { fmrl_0000: newRing(), fmrl_0001: newRing(), fmrl_0002: newRing() };
    await writeCredentials(file, { version: 1, keys: { [fake.baseUrl]: { key, prefix: fx.prefix, ring: active } },
      rings, ring_origins: Object.fromEntries(Object.keys(rings).map(p => [p, fake.baseUrl])) });
    const original = api.putRings.bind(api); let calls = 0;
    vi.spyOn(api, "putRings").mockImplementation(async (...args) => {
      if (++calls === 3) throw new ApiError(status, "failure", "");
      return original(...args);
    });
    expect(await sync.sync(key)).toMatchObject({ state: "unknown" });
    expect(calls).toBe(3); expectFixedLog();
    expect(openTestVaultBox(fx, fx.prefix, fake.ringBoxes.get(fx.prefix)!)).toBe(active);
  });
  it("bounds ownership isolation to 60 attempts and tries the active ring afresh next invocation", async () => {
    const rings = Object.fromEntries(Array.from({ length: 100 }, (_, n) => [`fmrl_${String(n).padStart(4, "0")}`, newRing()]));
    await writeCredentials(file, { version: 1, keys: { [fake.baseUrl]: { key, prefix: fx.prefix, ring: active } },
      rings, ring_origins: Object.fromEntries(Object.keys(rings).map(p => [p, fake.baseUrl])) });
    expect(await sync.sync(key)).toMatchObject({ state: "unknown" });
    expect(puts()).toBe(60); expectFixedLog();
    const box = fake.ringBoxes.get(fx.prefix)!; expect(openTestVaultBox(fx, fx.prefix, box)).toBe(active);
    expect(await sync.sync(key)).toMatchObject({ state: "unknown" });
    expect(puts()).toBe(120); expect(fake.ringBoxes.get(fx.prefix)).not.toBe(box);
  });
  it("keeps numeric variants and a stored-key variant last for non-active prefixes", async () => {
    const history = [newRing(), newRing(), newRing()];
    await writeCredentials(file, { version: 1, keys: {
      [fake.baseUrl]: { key, prefix: fx.prefix, ring: active },
      [`${fake.baseUrl}/alias`]: { key: "fmrl_OLD1", prefix: "fmrl_OLD1", ring: history[2] },
    }, rings: { "fmrl_OLD1.10": history[1], "fmrl_OLD1.2": history[0] },
      ring_origins: { "fmrl_OLD1.10": fake.baseUrl, "fmrl_OLD1.2": fake.baseUrl } });
    fake.ringClaims.set(key, new Set([fx.prefix, "fmrl_OLD1"]));
    expect(await sync.sync(key)).toMatchObject({ state: "synced" });
    expect(fake.ringBatches.flat().map(row => openTestVaultBox(fx, row.prefix, row.box))).toEqual([active, ...history]);
    expect(openTestVaultBox(fx, "fmrl_OLD1", fake.ringBoxes.get("fmrl_OLD1")!)).toBe(history[2]);
  });
  it("seals only the active-prefix ring first, preserving superseded history locally and a durable pin", async () => {
    expect(await sync.sync(key)).toEqual({ state: "synced", fingerprint: fx.fingerprint, firstPin: true });
    expect(fake.ringBatches.map(batch => batch.length)).toEqual([1]);
    expect(fake.ringBatches.flat().map(row => openTestVaultBox(fx, row.prefix, row.box))).toEqual([active]);
    expect(fake.ringBoxes.has(fx.prefix)).toBe(true);
    expect(openTestVaultBox(fx, fx.prefix, fake.ringBoxes.get(fx.prefix)!)).toBe(active);
    expect((await readCredentials(file)).vault_pins).toEqual({ [new URL(api.viewerBase).origin]: fx.fingerprint });
    const freshKeys = new KeyStore({ api, baseUrl: fake.baseUrl, file });
    expect(await new VaultSync({ api, keys: freshKeys }).sync(key)).toEqual({ state: "synced", fingerprint: fx.fingerprint, firstPin: false });
    expect(logs).toEqual([]);
  });
  it("each ordinary repeat gets me and PUTs again without caching boxes", async () => {
    await writeCredentials(file, { version: 1, keys: { [fake.baseUrl]: { key, prefix: fx.prefix, ring: active } } });
    await sync.sync(key); const before = fake.requests.length; const firstBox = fake.ringBoxes.get(fx.prefix);
    expect(await sync.sync(key)).toEqual({ state: "synced", fingerprint: fx.fingerprint, firstPin: false });
    expect(fake.requests.slice(before).map(q => [q.method, q.path])).toEqual([
      ["GET", "/api/v1/me"], ["PUT", "/api/v1/me/rings"],
    ]);
    expect(fake.ringBoxes.get(fx.prefix)).not.toBe(firstBox);
  });
  it("returns none without a vault and does not pin or upload", async () => {
    fake.accountVaults.delete(key);
    expect(await sync.sync(key)).toEqual({ state: "none" });
    expect(puts()).toBe(0); expect((await readCredentials(file)).vault_pins).toBeUndefined(); expect(logs).toEqual([]);
  });
  it("verifies the public key fingerprint before pinning, snapshotting or sealing", async () => {
    fake.accountVaults.set(key, { pub: fx.pub, fingerprint: replacement().fingerprint });
    const pin = vi.spyOn(keys, "pinVault"); const snapshot = vi.spyOn(keys, "vaultSnapshot");
    expect(await sync.sync(key)).toEqual({ state: "unknown", fingerprint: fx.fingerprint, firstPin: false });
    expect(pin).not.toHaveBeenCalled(); expect(snapshot).not.toHaveBeenCalled(); expect(puts()).toBe(0);
    expect((await readCredentials(file)).vault_pins).toBeUndefined(); expectFixedLog();
  });
  it.each([null, [], "bad", {}, { pub: 7, fingerprint: fx.fingerprint }, { pub: fx.pub },
    { pub: "bad", fingerprint: fx.fingerprint }, { pub: fx.pub + "=", fingerprint: fx.fingerprint }])
  ("contains malformed advertised vault %j as operational unknown", async value => {
    fake.accountVaults.set(key, value as AccountVault);
    expect(await sync.sync(key)).toEqual({ state: "unknown", firstPin: false });
    expect(puts()).toBe(0); expect((await readCredentials(file)).vault_pins).toBeUndefined(); expectFixedLog();
  });
  it("requires exact explicit trust to replace a changed vault", async () => {
    await sync.sync(key); fake.requests.length = 0; const next = replacement(); fake.accountVaults.set(key, next);
    for (const trust of [undefined, fx.fingerprint, next.fingerprint.toLowerCase(), "wrong"]) {
      expect(await sync.sync(key, { trust })).toEqual({ state: "changed", previous: fx.fingerprint, fingerprint: next.fingerprint });
      expect(puts()).toBe(0); expect((await readCredentials(file)).vault_pins?.[new URL(api.viewerBase).origin]).toBe(fx.fingerprint);
    }
    expect(await sync.sync(key, { trust: next.fingerprint })).toEqual({ state: "synced", fingerprint: next.fingerprint, firstPin: false });
    expect(puts()).toBe(1); expect((await readCredentials(file)).vault_pins?.[new URL(api.viewerBase).origin]).toBe(next.fingerprint);
  });
  it("rejects incorrect trust on a first pin without writing or uploading", async () => {
    expect(await sync.sync(key, { trust: "wrong" })).toEqual({ state: "unknown", fingerprint: fx.fingerprint, firstPin: false });
    expect((await readCredentials(file)).vault_pins).toBeUndefined(); expect(puts()).toBe(0); expectFixedLog();
  });
  it("a failed durable first-pin write prevents upload", async () => {
    const blocker = path.join(dir, "blocker"); await writeFile(blocker, "not a directory");
    const badKeys = new KeyStore({ api, baseUrl: fake.baseUrl, file: path.join(blocker, "credentials.json") });
    const badSync = new VaultSync({ api, keys: badKeys, log: line => logs.push(line) });
    expect(await badSync.sync(key)).toEqual({ state: "unknown", fingerprint: fx.fingerprint, firstPin: false });
    expect(puts()).toBe(0); expectFixedLog();
  });
  it.each([403, 409])("initial PUT %i is silent and preserves the first pin", async status => {
    fake.ringStatus = status;
    expect(await sync.sync(key)).toEqual({ state: "none", fingerprint: fx.fingerprint, firstPin: true });
    expect(puts()).toBe(1); expect(fake.ringBatches).toEqual([]); expect(logs).toEqual([]);
    expect((await readCredentials(file)).vault_pins).toBeDefined();
    fake.ringStatus = undefined;
    expect(await sync.sync(key)).toEqual({ state: "synced", fingerprint: fx.fingerprint, firstPin: false });
  });
  it.each([429, 500, 0])("PUT failure %i is unknown with one fixed secret-free log", async status => {
    const poisoned = [fx.ring, fx.box, fx.vault_key].join(" ");
    const put = vi.spyOn(api, "putRings").mockRejectedValue(new ApiError(status, "test", poisoned));
    expect(await sync.sync(key)).toEqual({ state: "unknown", fingerprint: fx.fingerprint, firstPin: true });
    expect(put).toHaveBeenCalledTimes(1); expectFixedLog();
    for (const secret of [fx.ring, fx.box, fx.vault_key]) expect(logs.join()).not.toContain(secret);
  });
  it.each([403, 409, 429, 500, 0])("stops after a successful batch then failed batch %i without claiming sync", async status => {
    await writeCredentials(file, { version: 1, keys: { [fake.baseUrl]: { key, prefix: fx.prefix, ring: active } },
      rings: { fmrl_old1: fx.ring, "fmrl_old1.2": newRing() },
      ring_origins: { fmrl_old1: fake.baseUrl, "fmrl_old1.2": fake.baseUrl } });
    const original = api.putRings.bind(api); let calls = 0;
    vi.spyOn(api, "putRings").mockImplementation(async (...args) => {
      if (++calls === 2) throw new ApiError(status, "test", fx.vault_key);
      return original(...args);
    });
    expect(await sync.sync(key)).toEqual({ state: "unknown", fingerprint: fx.fingerprint, firstPin: true });
    expect(calls).toBe(2); expect(fake.ringBatches).toHaveLength(1);
    expect(logs).toEqual(status === 403 || status === 409 ? [] : ["fmrl-mcp: vault sync failed"]);
  });
  it("refuses an incomplete stored count and stops remaining batches", async () => {
    const put = vi.spyOn(api, "putRings").mockResolvedValue({ stored: 0 });
    expect(await sync.sync(key)).toEqual({ state: "unknown", fingerprint: fx.fingerprint, firstPin: true });
    expect(put).toHaveBeenCalledTimes(1); expectFixedLog();
  });
  it("sends one empty batch without claiming synced when no local rings exist", async () => {
    await writeCredentials(file, { version: 1, keys: {} });
    expect(await sync.sync(key)).toEqual({ state: "unknown", fingerprint: fx.fingerprint, firstPin: true });
    expect(fake.ringBatches).toEqual([[]]);
  });
  it("uploads 51 distinct prefixes in 50 and 1 boxes without losing rings", async () => {
    const rings = Object.fromEntries(Array.from({ length: 51 }, (_, n) => [`fmrl_${String(n).padStart(4, "0")}`, newRing()]));
    await writeCredentials(file, { version: 1, keys: {}, rings,
      ring_origins: Object.fromEntries(Object.keys(rings).map(p => [p, fake.baseUrl])) });
    fake.ringClaims.set(key, new Set(Object.keys(rings)));
    expect(await sync.sync(key)).toMatchObject({ state: "unknown" });
    expect(fake.ringBatches.map(batch => batch.length)).toEqual([50, 1]);
    expect(fake.ringBatches.flat().map(row => [row.prefix, openTestVaultBox(fx, row.prefix, row.box)])).toEqual(Object.entries(rings));
  });
  it("uses a supplied invocation's fresh me without another GET", async () => {
    const me = await api.me(key); fake.requests.length = 0;
    expect(await sync.sync(key, { me })).toMatchObject({ state: "synced" });
    expect(fake.requests.map(q => q.method)).toEqual(["PUT"]);
  });
  it("serializes whole passes without collapsing either and frees the file queue during upload", async () => {
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    let entered!: () => void; const firstEntered = new Promise<void>(resolve => { entered = resolve; });
    const original = api.putRings.bind(api); let calls = 0;
    vi.spyOn(api, "putRings").mockImplementation(async (...args) => {
      if (++calls === 1) { entered(); await gate; }
      return original(...args);
    });
    const first = sync.sync(key); await firstEntered;
    const second = sync.sync(key);
    // A file operation must finish while the network operation is deliberately paused.
    expect((await keys.vaultSnapshot()).keys[fake.baseUrl].ring).toBe(active);
    expect(fake.requests.map(q => q.method)).toEqual(["GET"]);
    release(); expect(await first).toMatchObject({ state: "synced", firstPin: true });
    expect(await second).toMatchObject({ state: "synced", firstPin: false });
    expect(fake.requests.map(q => q.method)).toEqual(["GET", "PUT", "GET", "PUT"]);
  });
  it("contains primary me failures without reminting and leaves the queue usable", async () => {
    const original = api.me.bind(api);
    vi.spyOn(api, "me").mockRejectedValueOnce(new ApiError(401, "key_revoked", fx.ring)).mockImplementation(original);
    expect(await sync.sync(key)).toEqual({ state: "unknown", firstPin: false });
    expect(await sync.sync(key)).toMatchObject({ state: "synced", firstPin: true });
    expect(fake.requests.some(q => q.path === "/api/v1/keys")).toBe(false); expectFixedLog();
  });
  it("contains snapshot failures after pinning, without leaking errors", async () => {
    vi.spyOn(keys, "vaultSnapshot").mockRejectedValue(new Error(fx.box));
    expect(await sync.sync(key)).toEqual({ state: "unknown", fingerprint: fx.fingerprint, firstPin: true });
    expect(puts()).toBe(0); expectFixedLog();
  });
  it("contains a diagnostic callback failure and still permits the next sync", async () => {
    const log = vi.fn(() => { throw new Error(fx.vault_key); });
    const resilient = new VaultSync({ api, keys, log });
    fake.ringStatus = 500;
    await expect(resilient.sync(key)).resolves.toEqual({ state: "unknown", fingerprint: fx.fingerprint, firstPin: true });
    expect(log).toHaveBeenCalledExactlyOnceWith("fmrl-mcp: vault sync failed");
    fake.ringStatus = undefined;
    await expect(resilient.sync(key)).resolves.toMatchObject({ state: "synced", firstPin: false });
  });

});
