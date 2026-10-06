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
    }, rings: { "fmrl_test.10": rings[2], "fmrl_test.2": rings[1], fmrl_test: rings[0] } };
    const list = collectVaultRings(file, baseUrl);
    expect(list).toEqual(rings.map(ring => ({ prefix: "fmrl_test", ring })));
    expect(batchVaultRings(list)).toEqual(list.map(row => [row]));
  });
  it("includes every origin and revoked-key history, keeping the last exact pair occurrence", () => {
    const history = newRing(); const active = newRing(); const other = newRing(); const legacy = newRing();
    const file = { version: 1, keys: {
      "https://z.site": { key: "fmrl_test" + "z".repeat(28), prefix: "fmrl_test", ring: other },
      [baseUrl]: { key: "fmrl_test" + "x".repeat(28), prefix: "fmrl_test", ring: active },
      "https://a.site": { key: "fmrl_lgcy" + "a".repeat(28), ring: legacy },
      "https://b.site": { key: "fmrl_test" + "b".repeat(28), prefix: "fmrl_test", ring: history },
      "https://bad.site": null,
    }, rings: {
      "fmrl_test.3": history, fmrl_test: history, "fmrl_test.2": active,
      "fmrl_gone.12": other, "fmrl_gone.2": legacy, fmrl_gone: history,
      "fmrl_test.11": other,
    } } as unknown as CredentialsFile;
    expect(collectVaultRings(file, baseUrl)).toEqual([
      { prefix: "fmrl_gone", ring: history }, { prefix: "fmrl_gone", ring: legacy },
      { prefix: "fmrl_gone", ring: other }, { prefix: "fmrl_lgcy", ring: legacy },
      { prefix: "fmrl_test", ring: history }, { prefix: "fmrl_test", ring: other },
      { prefix: "fmrl_test", ring: active },
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
    } } as unknown as CredentialsFile;
    expect(collectVaultRings(file, baseUrl)).toEqual([
      { prefix: "fmrl_Ab12", ring }, { prefix: "fmrl_good", ring }, { prefix: "fmrl_long", ring },
    ]);
  });
  it("returns only credential-file rings, including when no configured key is stored", () => {
    const ring = newRing();
    expect(collectVaultRings({ version: 1, keys: {}, rings: { fmrl_test: ring } }, baseUrl))
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
    fake.accountVaults.set(key, advertised); fake.requests.length = 0;
  });
  afterEach(async () => { vi.restoreAllMocks(); await fake.close(); await rm(dir, { recursive: true, force: true }); });
  const replacement = (): AccountVault => {
    const ec = createECDH("prime256v1"); ec.generateKeys(); const pub = ec.getPublicKey().toString("base64url");
    return { pub, fingerprint: vaultFingerprint(pub) };
  };
  const puts = (): number => fake.requests.filter(q => q.path === "/api/v1/me/rings").length;
  const expectFixedLog = (): void => { expect(logs).toEqual(["fmrl-mcp: vault sync failed"]); };

  it("seals every variant independently, with the active ring last and a durable first pin", async () => {
    expect(await sync.sync(key)).toEqual({ state: "synced", fingerprint: fx.fingerprint, firstPin: true });
    expect(fake.ringBatches.map(batch => batch.length)).toEqual([1, 1]);
    expect(fake.ringBatches.flat().map(row => openTestVaultBox(fx, row.prefix, row.box))).toEqual([fx.ring, active]);
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
    expect(puts()).toBe(2); expect((await readCredentials(file)).vault_pins?.[new URL(api.viewerBase).origin]).toBe(next.fingerprint);
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
      rings: { [fx.prefix]: fx.ring, [`${fx.prefix}.2`]: newRing() } });
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
  it("sends one empty batch when no local rings exist", async () => {
    await writeCredentials(file, { version: 1, keys: {} });
    expect(await sync.sync(key)).toEqual({ state: "synced", fingerprint: fx.fingerprint, firstPin: true });
    expect(fake.ringBatches).toEqual([[]]);
  });
  it("uploads 51 distinct prefixes in 50 and 1 boxes without losing rings", async () => {
    const rings = Object.fromEntries(Array.from({ length: 51 }, (_, n) => [`fmrl_${String(n).padStart(4, "0")}`, newRing()]));
    await writeCredentials(file, { version: 1, keys: {}, rings });
    expect(await sync.sync(key)).toMatchObject({ state: "synced" });
    expect(fake.ringBatches.map(batch => batch.length)).toEqual([50, 1]);
    expect(fake.ringBatches.flat().map(row => [row.prefix, openTestVaultBox(fx, row.prefix, row.box)])).toEqual(Object.entries(rings));
  });
  it("uses a supplied invocation's fresh me without another GET", async () => {
    const me = await api.me(key); fake.requests.length = 0;
    expect(await sync.sync(key, { me })).toMatchObject({ state: "synced" });
    expect(fake.requests.map(q => q.method)).toEqual(["PUT", "PUT"]);
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
    expect(fake.requests.map(q => q.method)).toEqual(["GET", "PUT", "PUT", "GET", "PUT", "PUT"]);
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
