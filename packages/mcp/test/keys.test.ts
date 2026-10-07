import { mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createECDH } from "node:crypto";
import { newRing } from "../src/crypto.js";
import { vaultFingerprint } from "../src/vault-crypto.js";
import { FmrlApi } from "../src/api.js";
import { readCredentials, writeCredentials } from "../src/credentials.js";
import { KeyStore, normalizeKeyCode } from "../src/keys.js";
import { startFakeApi, type FakeApi } from "./fake-api.js";

type CredentialsWithOrigins = { ring_origins?: Record<string, string> };
let fake: FakeApi; let api: FmrlApi; let file: string; const logs: string[] = [];
beforeEach(async () => { fake = await startFakeApi(); api = new FmrlApi(fake.baseUrl); file = path.join(await mkdtemp(path.join(tmpdir(), "fmrl-")), "credentials.json"); logs.length = 0; });
afterEach(async () => { await fake.close(); });

describe("KeyStore", () => {
  it("mints on first use, saves under the base url, and reuses the key", async () => {
    const store = new KeyStore({ api, baseUrl: fake.baseUrl, file, log: (s) => logs.push(s) });
    const k1 = await store.getKey();
    const saved = await readCredentials(file);
    expect(saved.keys[fake.baseUrl]).toMatchObject({ key: k1, prefix: k1.slice(0, 9) });
    expect(logs.join("\n")).toMatch(/minted .*fmrl_/);
    const k2 = await new KeyStore({ api, baseUrl: fake.baseUrl, file }).getKey();
    expect(k2).toBe(k1);
    expect(fake.requests.filter((r) => r.path === "/api/v1/keys")).toHaveLength(1);
  });
  it("prefers FMRL_API_KEY and never writes it", async () => {
    const store = new KeyStore({ api, baseUrl: fake.baseUrl, file, apiKeyFromEnv: "fmrl_" + "E".repeat(32) });
    expect(await store.getKey()).toBe("fmrl_" + "E".repeat(32));
    expect((await readCredentials(file)).keys).toEqual({});
  });
  it("re-mints once on a 401 for a stored key, then reports a second 401", async () => {
    await writeCredentials(file, { version: 1, keys: { [fake.baseUrl]: { key: "fmrl_" + "S".repeat(32), prefix: "fmrl_SSSS", created_at: "x" } } });
    const store = new KeyStore({ api, baseUrl: fake.baseUrl, file });
    const me = await store.withKey((k) => api.me(k));
    expect(me.prefix).not.toBe("fmrl_SSSS");
    expect((await readCredentials(file)).keys[fake.baseUrl].key).toMatch(/^fmrl_/);
    // Now make the stored key invalid again with no room to mint: a second 401 surfaces.
    fake.keys.clear();
    fake.mintLimit = 0;
    await expect(store.withKey((k) => api.me(k))).rejects.toMatchObject({ status: 429 });
  });
  it("does not re-mint when the key came from the environment", async () => {
    const store = new KeyStore({ api, baseUrl: fake.baseUrl, file, apiKeyFromEnv: "fmrl_" + "E".repeat(32) });
    await expect(store.withKey((k) => api.me(k))).rejects.toMatchObject({ status: 401 });
    expect(fake.requests.filter((r) => r.path === "/api/v1/keys")).toHaveLength(0);
  });
  it("never retries a 402 or 422", async () => {
    const store = new KeyStore({ api, baseUrl: fake.baseUrl, file });
    await expect(store.withKey((k) => api.publish(k, { content: "PHISH" }))).rejects.toMatchObject({ status: 422 });
    expect(fake.requests.filter((r) => r.path === "/api/v1/publish")).toHaveLength(1);
  });
  it("single-flights concurrent mints on a fresh store into one request", async () => {
    const store = new KeyStore({ api, baseUrl: fake.baseUrl, file });
    const [k1, k2, k3] = await Promise.all([store.getKey(), store.getKey(), store.getKey()]);
    expect(k1).toBe(k2);
    expect(k2).toBe(k3);
    expect(fake.requests.filter((r) => r.path === "/api/v1/keys")).toHaveLength(1);
  });
  it("moves a malformed credentials file aside instead of destroying its key and ring on the next write", async () => {
    const oldRing = "R".repeat(43);
    const otherRing = "O".repeat(43);
    const original =
      JSON.stringify({
        version: 1,
        keys: { [fake.baseUrl]: { key: "fmrl_" + "S".repeat(32), prefix: "fmrl_SSSS", created_at: "t", ring: oldRing } },
        rings: { fmrl_old1: otherRing },
      }) + ",";
    await writeFile(file, original);
    const store = new KeyStore({ api, baseUrl: fake.baseUrl, file, log: (s) => logs.push(s) });
    const fresh = await store.getKey();
    expect(fresh).not.toBe("fmrl_" + "S".repeat(32));
    const dir = path.dirname(file);
    const asideNames = (await readdir(dir)).filter((n) => n.startsWith("credentials.json.unreadable-"));
    expect(asideNames).toHaveLength(1);
    expect(await readFile(path.join(dir, asideNames[0]), "utf8")).toBe(original);
    // A fresh credentials.json exists and was not overwritten in place.
    expect((await readCredentials(file)).keys[fake.baseUrl].key).toBe(fresh);
    const joined = logs.join("\n");
    expect(joined).toContain(asideNames[0]);
    expect(joined).not.toContain(oldRing);
    expect(joined).not.toContain(otherRing);
  });
});

describe("KeyStore rings", () => {
  it("records provenance for newly filed and environment-key rings without relabeling legacy history", async () => {
    const old = newRing(); const legacy = newRing();
    await writeCredentials(file, { version: 1, keys: {
      [fake.baseUrl]: { key: "fmrl_OLD1" + "x".repeat(28), prefix: "fmrl_OLD1", ring: old },
    }, rings: { fmrl_OLD1: legacy } });
    const store = new KeyStore({ api, baseUrl: fake.baseUrl, file });
    await store.adopt("fmrl_NEW1" + "x".repeat(28), "fmrl_NEW1");
    const env = new KeyStore({ api, baseUrl: fake.baseUrl, file, apiKeyFromEnv: "fmrl_ENV1" + "x".repeat(28) });
    await env.ringFor(await env.getKey());
    const saved = await readCredentials(file);
    expect((saved as CredentialsWithOrigins).ring_origins).toEqual({ "fmrl_OLD1.2": fake.baseUrl, fmrl_ENV1: fake.baseUrl });
    expect(saved.rings!.fmrl_OLD1).toBe(legacy);
  });
  it("never reuses or overwrites another origin's historical ring when prefixes collide", async () => {
    const foreign = newRing();
    await writeCredentials(file, { version: 1, keys: {}, rings: { fmrl_ENV1: foreign },
      ring_origins: { fmrl_ENV1: "https://fmrl.site" } });
    const envKey = "fmrl_ENV1" + "x".repeat(28);
    const store = new KeyStore({ api, baseUrl: fake.baseUrl, file, apiKeyFromEnv: envKey });
    const ring = await store.ringFor(envKey);
    expect(ring).not.toBe(foreign);
    expect(await new KeyStore({ api, baseUrl: fake.baseUrl, file, apiKeyFromEnv: envKey }).ringFor(envKey)).toBe(ring);
    const saved = await readCredentials(file);
    expect(saved.rings).toEqual({ fmrl_ENV1: foreign, "fmrl_ENV1.2": ring });
    expect(saved.ring_origins).toEqual({ fmrl_ENV1: "https://fmrl.site", "fmrl_ENV1.2": fake.baseUrl });
  });
  const RING = /^[A-Za-z0-9_-]{43}$/;
  it("mints a ring once, keeps it on the stored key, and logs the prefix but never the ring", async () => {
    const store = new KeyStore({ api, baseUrl: fake.baseUrl, file, log: (s) => logs.push(s) });
    const key = await store.getKey();
    const ring = await store.ringFor(key);
    expect(ring).toMatch(RING);
    expect((await readCredentials(file)).keys[fake.baseUrl].ring).toBe(ring);
    expect(await store.ringFor(key)).toBe(ring);
    expect(await new KeyStore({ api, baseUrl: fake.baseUrl, file }).ringFor(key)).toBe(ring);
    expect(logs.join("\n")).toContain(`minted a key ring for ${key.slice(0, 9)}…`);
    expect(logs.join("\n")).not.toContain(ring);
  });
  it("shares one mint between concurrent calls", async () => {
    const store = new KeyStore({ api, baseUrl: fake.baseUrl, file });
    const key = await store.getKey();
    const rings = await Promise.all([store.ringFor(key), store.ringFor(key), store.ringFor(key)]);
    expect(new Set(rings).size).toBe(1);
    expect((await readCredentials(file)).keys[fake.baseUrl].ring).toBe(rings[0]);
  });
  it("prefers FMRL_RING and never writes it", async () => {
    const envRing = "E".repeat(43);
    const store = new KeyStore({ api, baseUrl: fake.baseUrl, file, ringFromEnv: envRing });
    expect(store.ringFromEnv).toBe(true);
    const key = await store.getKey();
    expect(await store.ringFor(key)).toBe(envRing);
    const saved = await readCredentials(file);
    expect(saved.keys[fake.baseUrl].ring).toBeUndefined();
    expect(saved.rings).toBeUndefined();
    expect(await store.ringsFor(key)).toEqual([envRing]);
  });
  it("keeps an environment key's ring under rings[prefix]", async () => {
    const envKey = "fmrl_" + "E".repeat(32);
    const store = new KeyStore({ api, baseUrl: fake.baseUrl, file, apiKeyFromEnv: envKey });
    const ring = await store.ringFor(envKey);
    const saved = await readCredentials(file);
    expect(saved.keys).toEqual({});
    expect(saved.rings).toEqual({ fmrl_EEEE: ring });
    expect(saved.ring_origins).toEqual({ fmrl_EEEE: fake.baseUrl });
    expect(await new KeyStore({ api, baseUrl: fake.baseUrl, file, apiKeyFromEnv: envKey }).ringFor(envKey)).toBe(ring);
  });
  it("an environment key that is also the stored key seals under the stored key's ring", async () => {
    const stored = await new KeyStore({ api, baseUrl: fake.baseUrl, file }).getKey();
    const ring = await new KeyStore({ api, baseUrl: fake.baseUrl, file }).ringFor(stored);
    expect(await new KeyStore({ api, baseUrl: fake.baseUrl, file, apiKeyFromEnv: stored }).ringFor(stored)).toBe(ring);
  });
  it("moves a replaced key's ring to rings[oldPrefix] and mints the new key its own", async () => {
    const oldRing = "O".repeat(43);
    await writeCredentials(file, { version: 1, keys: { [fake.baseUrl]: { key: "fmrl_" + "S".repeat(32), prefix: "fmrl_SSSS", created_at: "x", ring: oldRing } } });
    const store = new KeyStore({ api, baseUrl: fake.baseUrl, file });
    const fresh = await store.withKey(async (k) => { await api.me(k); return k; });
    const saved = await readCredentials(file);
    expect(saved.rings).toEqual({ fmrl_SSSS: oldRing });
    expect(saved.ring_origins).toEqual({ fmrl_SSSS: fake.baseUrl });
    expect(saved.keys[fake.baseUrl].ring).toBeUndefined();
    const ring = await store.ringFor(fresh);
    expect(ring).not.toBe(oldRing);
    expect(await store.ringsFor(fresh)).toEqual([ring, oldRing]);
  });
  it("ringsFor never mints", async () => {
    const store = new KeyStore({ api, baseUrl: fake.baseUrl, file });
    const key = await store.getKey();
    expect(await store.ringsFor(key)).toEqual([]);
    expect((await readCredentials(file)).keys[fake.baseUrl].ring).toBeUndefined();
  });
  it("replaces a malformed stored ring rather than sealing under it", async () => {
    const store = new KeyStore({ api, baseUrl: fake.baseUrl, file });
    const key = await store.getKey();
    const saved = await readCredentials(file);
    saved.keys[fake.baseUrl].ring = "not-a-ring";
    await writeCredentials(file, saved);
    const ring = await store.ringFor(key);
    expect(ring).toMatch(RING);
    expect((await readCredentials(file)).keys[fake.baseUrl].ring).toBe(ring);
  });
  it("names its file", () => {
    expect(new KeyStore({ api, baseUrl: fake.baseUrl, file }).file).toBe(file);
  });
  it("does not lose a ring minted for a different key in a concurrent call", async () => {
    const store = new KeyStore({ api, baseUrl: fake.baseUrl, file });
    const storedKeyValue = await store.getKey();
    const otherKey = "fmrl_" + "X".repeat(32);
    const [storedKeyRing, otherKeyRing] = await Promise.all([store.ringFor(storedKeyValue), store.ringFor(otherKey)]);
    const saved = await readCredentials(file);
    expect(saved.keys[fake.baseUrl].ring).toBe(storedKeyRing);
    expect(saved.rings).toEqual({ fmrl_XXXX: otherKeyRing });
  });
});

describe("normalizeKeyCode", () => {
  it("strips dashes and whitespace and uppercases, as keylife.Redeem does", () => {
    const code = "K7QXM2PAD4RTW6BH3NCEYABCDE";
    expect(normalizeKeyCode("K7QX-M2PA-D4RT-W6BH-3NCE-YABC-DE")).toBe(code);
    expect(normalizeKeyCode(" k7qx m2pa\td4rt-w6bh\n3nce yabc de ")).toBe(code);
  });
  it("refuses anything that isn't 26 base32 characters", () => {
    expect(normalizeKeyCode("K7QX-M2PA-9D4R-TW6B-H3NC-EY")).toBeUndefined(); // 9 is not base32
    expect(normalizeKeyCode("K7QX-M2PA")).toBeUndefined();
    expect(normalizeKeyCode("K7QXM2PAD4RTW6BH3NCEYABCDEF")).toBeUndefined();
    expect(normalizeKeyCode("K7QXM2PAD4RTW6BH3NCEYABC=E")).toBeUndefined();
    expect(normalizeKeyCode("")).toBeUndefined();
  });
});

describe("KeyStore.adopt", () => {
  const ringA = "A".repeat(43);
  const ringB = "B".repeat(43);
  it("a rotated key under the stored prefix keeps its ring and when it was made, and is used from then on", async () => {
    const store = new KeyStore({ api, baseUrl: fake.baseUrl, file });
    const old = await store.getKey();
    await store.ringFor(old);
    const before = (await readCredentials(file)).keys[fake.baseUrl];
    const fresh = old.slice(0, 9) + "N".repeat(28);
    expect(await store.adopt(fresh, old.slice(0, 9))).toEqual({ same: true });
    const after = await readCredentials(file);
    expect(after.keys[fake.baseUrl]).toEqual({ key: fresh, prefix: old.slice(0, 9), created_at: before.created_at, ring: before.ring });
    expect(after.rings).toBeUndefined();
    expect(await store.getKey()).toBe(fresh);
    expect(await store.ringFor(fresh)).toBe(before.ring);
  });
  it("a rotated key keeps its ring and prefix although the new secret's own first characters differ, as the server rotates", async () => {
    const store = new KeyStore({ api, baseUrl: fake.baseUrl, file, log: (s) => logs.push(s) });
    const old = await store.getKey();
    const ring = await store.ringFor(old);
    const r = await api.rotate(old);
    expect(r.key.slice(0, 9)).not.toBe(r.prefix);
    expect(await store.adopt(r.key, r.prefix)).toEqual({ same: true });
    expect(await store.prefixFor(r.key)).toBe(r.prefix);
    expect(await store.ringFor(r.key)).toBe(ring);
    expect(await store.ringsFor(r.key)).toEqual([ring]);
    expect((await readCredentials(file)).rings).toBeUndefined();
    expect(logs.join("\n")).not.toContain("minted a key ring for " + r.key.slice(0, 9));
  });
  it("another key moves the stored key's ring under its prefix and leaves the rings already filed alone", async () => {
    await writeCredentials(file, {
      version: 1,
      keys: { [fake.baseUrl]: { key: "fmrl_OLD1" + "o".repeat(28), prefix: "fmrl_OLD1", created_at: "t", ring: ringA } },
      rings: { fmrl_NEW1: ringB },
    });
    const store = new KeyStore({ api, baseUrl: fake.baseUrl, file });
    const fresh = "fmrl_NEW1" + "n".repeat(28);
    expect(await store.adopt(fresh, "fmrl_NEW1")).toEqual({ same: false, replaced: "fmrl_OLD1" });
    const after = await readCredentials(file);
    expect(after.keys[fake.baseUrl]).toEqual({ key: fresh, prefix: "fmrl_NEW1" });
    expect(after.rings).toEqual({ fmrl_OLD1: ringA, fmrl_NEW1: ringB });
    // The ring filed under the redeemed key's prefix is the one it seals under.
    expect(await store.ringFor(fresh)).toBe(ringB);
  });
  it("with no stored key, saves the key and replaces nothing", async () => {
    const store = new KeyStore({ api, baseUrl: fake.baseUrl, file });
    const fresh = "fmrl_NEW1" + "n".repeat(28);
    expect(await store.adopt(fresh, "fmrl_NEW1")).toEqual({ same: false });
    expect((await readCredentials(file)).keys[fake.baseUrl]).toEqual({ key: fresh, prefix: "fmrl_NEW1" });
    expect(fake.requests).toHaveLength(0);
  });
  it("keeps the key for this process even when the file can't be written", async () => {
    const store = new KeyStore({ api, baseUrl: fake.baseUrl, file: path.join(file, "nested", "credentials.json") });
    await writeFile(file, "not a directory");
    const fresh = "fmrl_NEW1" + "n".repeat(28);
    await expect(store.adopt(fresh, "fmrl_NEW1")).rejects.toThrow();
    expect(await store.getKey()).toBe(fresh);
  });
});

describe("KeyStore.withKey and a revoked key", () => {
  it("replaces a revoked stored key by default", async () => {
    const store = new KeyStore({ api, baseUrl: fake.baseUrl, file });
    const old = await store.getKey();
    fake.revoked.add(old);
    const me = await store.withKey((k) => api.me(k));
    expect(me.prefix).not.toBe(old.slice(0, 9));
  });
  it("with replaceRevoked false, a 401 key_revoked surfaces and nothing is minted", async () => {
    const store = new KeyStore({ api, baseUrl: fake.baseUrl, file });
    const old = await store.getKey();
    fake.revoked.add(old);
    await expect(store.withKey((k) => api.me(k), { replaceRevoked: false })).rejects.toMatchObject({ status: 401, code: "key_revoked" });
    expect(fake.requests.filter((r) => r.path === "/api/v1/keys")).toHaveLength(1);
    expect((await readCredentials(file)).keys[fake.baseUrl].key).toBe(old);
  });
  it("with replaceRevoked false, any other 401 is still replaced", async () => {
    const store = new KeyStore({ api, baseUrl: fake.baseUrl, file });
    const old = await store.getKey();
    fake.keys.clear();
    const me = await store.withKey((k) => api.me(k), { replaceRevoked: false });
    expect(me.prefix).not.toBe(old.slice(0, 9));
  });
});

describe("a key that changed under a call", () => {
  it("a 401 from the old key after a rotation retries with the rotated key rather than minting over it", async () => {
    const store = new KeyStore({ api, baseUrl: fake.baseUrl, file });
    const old = await store.getKey();
    const r = await api.rotate(old);
    let calls = 0;
    const me = await store.withKey(async (k) => {
      // The call started with the old key; the rotation lands before it answers.
      if (calls++ === 0) await store.adopt(r.key, r.prefix);
      return api.me(k);
    });
    expect(me.prefix).toBe(old.slice(0, 9));
    expect(fake.requests.filter((q) => q.path === "/api/v1/keys")).toHaveLength(1);
    expect((await readCredentials(file)).keys[fake.baseUrl].key).toBe(r.key);
  });
  it("a rotation adopted after the 401's check but before its mint lands is kept, not minted over", async () => {
    const store = new KeyStore({ api, baseUrl: fake.baseUrl, file });
    const old = await store.getKey();
    const r = await api.rotate(old);
    // The window: the 401's check has already found the old key current when the rotation is adopted.
    const s = store as unknown as { changedSince(f: string): Promise<string | undefined> };
    const check = s.changedSince.bind(store);
    s.changedSince = async (f) => { const found = await check(f); void store.adopt(r.key, r.prefix); return found; };
    const me = await store.withKey((k) => api.me(k));
    expect(me.prefix).toBe(old.slice(0, 9));
    expect((await readCredentials(file)).keys[fake.baseUrl].key).toBe(r.key);
    expect(await store.getKey()).toBe(r.key);
  });
  it("another process's rotation, found in the file on a 401, is used instead of minting", async () => {
    const x = new KeyStore({ api, baseUrl: fake.baseUrl, file });
    const old = await x.getKey();
    const y = new KeyStore({ api, baseUrl: fake.baseUrl, file });
    const r = await api.rotate(await y.getKey());
    await y.adopt(r.key, r.prefix);
    const me = await x.withKey((k) => api.me(k));
    expect(me.prefix).toBe(old.slice(0, 9));
    expect(fake.requests.filter((q) => q.path === "/api/v1/keys")).toHaveLength(1);
    expect(await x.getKey()).toBe(r.key);
  });
});

describe("rings under a shared prefix", () => {
  const ringA = "A".repeat(43);
  const ringB = "B".repeat(43);
  it("a rotated secret of the stored key seals under the stored entry's ring", async () => {
    await writeCredentials(file, { version: 1, keys: { [fake.baseUrl]: { key: "fmrl_PPPP" + "1".repeat(28), prefix: "fmrl_PPPP", created_at: "t", ring: ringA } } });
    const store = new KeyStore({ api, baseUrl: fake.baseUrl, file, apiKeyFromEnv: "fmrl_PPPP" + "2".repeat(28) });
    expect(await store.ringFor("fmrl_PPPP" + "2".repeat(28))).toBe(ringA);
    expect((await readCredentials(file)).rings).toBeUndefined();
  });
  it("a mint that replaces the stored key never overwrites a different ring filed under its prefix", async () => {
    await writeCredentials(file, {
      version: 1,
      keys: { [fake.baseUrl]: { key: "fmrl_PPPP" + "1".repeat(28), prefix: "fmrl_PPPP", created_at: "t", ring: ringA } },
      rings: { fmrl_PPPP: ringB },
    });
    const store = new KeyStore({ api, baseUrl: fake.baseUrl, file });
    await store.withKey((k) => api.me(k)); // the stored key is unknown: 401, then a mint
    const kept = Object.values((await readCredentials(file)).rings ?? {});
    expect(kept.sort()).toEqual([ringA, ringB]);
    expect((await readCredentials(file)).rings!.fmrl_PPPP).toBe(ringB);
  });
  it("adopting another key never overwrites a different ring filed under the old prefix", async () => {
    await writeCredentials(file, {
      version: 1,
      keys: { [fake.baseUrl]: { key: "fmrl_PPPP" + "1".repeat(28), prefix: "fmrl_PPPP", created_at: "t", ring: ringA } },
      rings: { fmrl_PPPP: ringB },
    });
    const store = new KeyStore({ api, baseUrl: fake.baseUrl, file });
    await store.adopt("fmrl_QQQQ" + "q".repeat(28), "fmrl_QQQQ");
    const rings = (await readCredentials(file)).rings!;
    expect(rings.fmrl_PPPP).toBe(ringB);
    expect(Object.values(rings).sort()).toEqual([ringA, ringB]);
    expect(await store.ringsFor("fmrl_PPPP" + "3".repeat(28))).toEqual(expect.arrayContaining([ringA, ringB]));
  });
});

describe("a key replaced while another call was out", () => {
  it("with replaceRevoked false, a revoked key that another process already replaced is retried with the replacement", async () => {
    const x = new KeyStore({ api, baseUrl: fake.baseUrl, file });
    const old = await x.getKey();
    fake.revoked.add(old);
    // y, sharing the file, replaces the revoked key first.
    const y = new KeyStore({ api, baseUrl: fake.baseUrl, file });
    const theirs = await y.withKey((k) => api.me(k));
    const me = await x.withKey((k) => api.me(k), { replaceRevoked: false });
    expect(me.prefix).toBe(theirs.prefix);
    expect(fake.requests.filter((q) => q.path === "/api/v1/keys")).toHaveLength(2);
  });
  it("a rotation adopted while a 401's mint is in flight is what the call retries with, and the mint is dropped", async () => {
    const store = new KeyStore({ api, baseUrl: fake.baseUrl, file });
    const old = await store.getKey();
    const r = await api.rotate(old);
    let adopting: Promise<unknown> = Promise.resolve();
    const s = store as unknown as { mintOnce(replacing?: string): Promise<string> };
    const orig = s.mintOnce.bind(store);
    s.mintOnce = (replacing) => { const p = orig(replacing); adopting = store.adopt(r.key, r.prefix); return p; };
    const me = await store.withKey((k) => api.me(k));
    await adopting;
    expect(me.prefix).toBe(r.prefix);
    expect(fake.requests.filter((q) => q.path === "/api/v1/me").at(-1)).toMatchObject({ auth: `Bearer ${r.key}` });
    expect((await readCredentials(file)).keys[fake.baseUrl].key).toBe(r.key);
    expect(await store.getKey()).toBe(r.key);
  });
  it("a first mint stands down for a key another process stored while it was in flight", async () => {
    const y = new KeyStore({ api, baseUrl: fake.baseUrl, file });
    const slow = new FmrlApi(fake.baseUrl);
    let theirs = "";
    slow.mint = async (label) => { const m = await FmrlApi.prototype.mint.call(slow, label); theirs = await y.getKey(); return m; };
    const x = new KeyStore({ api: slow, baseUrl: fake.baseUrl, file });
    expect(await x.getKey()).toBe(theirs);
    expect((await readCredentials(file)).keys[fake.baseUrl].key).toBe(theirs);
  });
});

describe("KeyStore.ringsFor and the stored entry", () => {
  const ringA = "A".repeat(43);
  it("offers the stored entry's ring to a secret it doesn't match, such as FMRL_API_KEY set to the stored key's rotated secret", async () => {
    await writeCredentials(file, { version: 1, keys: { [fake.baseUrl]: { key: "fmrl_PPPP" + "1".repeat(28), prefix: "fmrl_PPPP", created_at: "t", ring: ringA } } });
    const env = "fmrl_QQQQ" + "2".repeat(28);
    const store = new KeyStore({ api, baseUrl: fake.baseUrl, file, apiKeyFromEnv: env });
    expect(await store.ringsFor(env)).toContain(ringA);
    expect(await store.prefixFor(env)).toBe("fmrl_QQQQ");
  });
});


describe("KeyStore vault pins", () => {
  function fingerprint(): string {
    const ecdh = createECDH("prime256v1");
    return vaultFingerprint(ecdh.generateKeys().toString("base64url"));
  }
  it("persists first pins, refuses changes until explicitly trusted, and shares a pin across paths", async () => {
    const store = new KeyStore({ api, baseUrl: fake.baseUrl, file });
    const first = fingerprint(); const other = fingerprint();
    expect(await store.pinVault("https://fmrl.site/api", first)).toEqual({ kind: "accepted", first: true });
    expect(await store.pinVault("https://fmrl.site/another", first)).toEqual({ kind: "accepted", first: false });
    expect(await store.pinVault("https://fmrl.site", other)).toEqual({ kind: "changed", previous: first });
    expect(await store.pinVault("https://fmrl.site", other, first)).toEqual({ kind: "changed", previous: first });
    expect((await readCredentials(file)).vault_pins).toEqual({ "https://fmrl.site": first });
    expect(await store.pinVault("https://fmrl.site", other, other)).toEqual({ kind: "accepted", first: false });
    expect(await store.pinVault("https://preview.fmrl.site", first)).toEqual({ kind: "accepted", first: true });
    expect((await readCredentials(file)).vault_pins).toEqual({ "https://fmrl.site": other, "https://preview.fmrl.site": first });
    if (process.platform !== "win32") {
      expect((await stat(file)).mode & 0o777).toBe(0o600);
      expect((await stat(path.dirname(file))).mode & 0o777).toBe(0o700);
    }
  });
  it("does not create a file or pin for a mismatching first trust", async () => {
    const store = new KeyStore({ api, baseUrl: fake.baseUrl, file });
    expect(await store.pinVault("https://fmrl.site", fingerprint(), fingerprint())).toEqual({ kind: "invalid-trust" });
    await expect(stat(file)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("rejects invalid method input with fixed errors before writing", async () => {
    const store = new KeyStore({ api, baseUrl: fake.baseUrl, file });
    const pin = fingerprint();
    for (const origin of ["invalid", "file:///tmp/vault", "https://user:password@fmrl.site"]) {
      await expect(store.pinVault(origin, pin)).rejects.toThrow("invalid vault origin");
    }
    for (const value of ["invalid", pin.toLowerCase(), "AAAA AAAA AAAA AAAA AAAA AAAA AB"]) {
      await expect(store.pinVault("https://fmrl.site", value)).rejects.toThrow("invalid vault fingerprint");
    }
    await expect(stat(file)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("serializes pin, ring, adoption and snapshot operations through the existing queue", async () => {
    const oldKey = "fmrl_old1" + "x".repeat(28); const nextKey = "fmrl_new1" + "y".repeat(28);
    const keptRing = newRing(); const pin = fingerprint();
    await writeFile(file, JSON.stringify({ version: 1,
      keys: { [fake.baseUrl]: { key: oldKey, prefix: "fmrl_old1" } },
      rings: { fmrl_kept: keptRing }, extension: { kept: true },
    }));
    const store = new KeyStore({ api, baseUrl: fake.baseUrl, file });
    const pinning = store.pinVault("https://fmrl.site", pin);
    const oldRing = store.ringFor(oldKey);
    const adopting = store.adopt(nextKey, "fmrl_new1");
    const nextRing = store.ringFor(nextKey);
    const snapshot = store.vaultSnapshot();
    const [pinResult, old, adoption, next, saved] = await Promise.all([pinning, oldRing, adopting, nextRing, snapshot]);
    expect(pinResult).toEqual({ kind: "accepted", first: true });
    expect(adoption).toEqual({ same: false, replaced: "fmrl_old1" });
    expect(saved).toEqual({ version: 1,
      keys: { [fake.baseUrl]: { key: nextKey, prefix: "fmrl_new1", ring: next } },
      rings: { fmrl_kept: keptRing, fmrl_old1: old }, ring_origins: { fmrl_old1: fake.baseUrl }, extension: { kept: true },
      vault_pins: { "https://fmrl.site": pin },
    });
    expect(await readCredentials(file)).toEqual(saved);
  });
  it("vault reads preserve backups and emit only fixed move-aside warnings", async () => {
    const store = new KeyStore({ api, baseUrl: fake.baseUrl, file, log: (line) => logs.push(line) });
    await writeFile(file, "invalid json");
    expect(await store.vaultSnapshot()).toEqual({ version: 1, keys: {} });
    const pinFile = path.join(path.dirname(file), "pin-credentials.json");
    await writeFile(pinFile, "invalid json");
    const pinStore = new KeyStore({ api, baseUrl: fake.baseUrl, file: pinFile, log: line => logs.push(line) });
    await pinStore.pinVault("https://fmrl.site", fingerprint());
    expect(logs).toEqual(["fmrl-mcp: credentials moved aside", "fmrl-mcp: credentials moved aside"]);
    const backups = (await readdir(path.dirname(file))).filter(name => name.includes(".unreadable-"));
    expect(backups).toHaveLength(2);
    for (const backup of backups) expect(await readFile(path.join(path.dirname(file), backup), "utf8")).toBe("invalid json");
    expect(logs.join()).not.toContain(file);
  });
  it("vault recovery tolerates a throwing logger", async () => {
    const store = new KeyStore({ api, baseUrl: fake.baseUrl, file, log: () => { throw new Error("poisoned"); } });
    await writeFile(file, "invalid json");
    expect(await store.vaultSnapshot()).toEqual({ version: 1, keys: {} });
    await writeFile(file, "invalid json");
    expect(await store.pinVault("https://fmrl.site", fingerprint())).toEqual({ kind: "accepted", first: true });
  });
});

describe("peek", () => {
  it("describes the stored key and its ring without minting either", async () => {
    const store = new KeyStore({ api, baseUrl: fake.baseUrl, file });
    expect(await store.peek()).toBeUndefined();
    const k = await store.getKey();
    expect(await store.peek()).toEqual({ prefix: k.slice(0, 9), source: "file", file, createdAt: expect.any(String), ring: "none" });
    await store.ringFor(k);
    expect((await store.peek())!.ring).toBe("file");
    expect(fake.requests.map((r) => r.path)).toEqual(["/api/v1/keys"]);
  });
  it("names the environment as the source of a key or ring that comes from it, and a redeemed key has no mint date", async () => {
    const store = new KeyStore({ api, baseUrl: fake.baseUrl, file, apiKeyFromEnv: "fmrl_" + "E".repeat(32), ringFromEnv: "R".repeat(43) });
    expect(await store.peek()).toEqual({ prefix: "fmrl_EEEE", source: "env", file, ring: "env" });
    expect(fake.requests).toHaveLength(0);
    await writeCredentials(file, { version: 1, keys: { [fake.baseUrl]: { key: "fmrl_" + "D".repeat(32), prefix: "fmrl_RDMD" } } });
    expect(await new KeyStore({ api, baseUrl: fake.baseUrl, file }).peek()).toEqual({ prefix: "fmrl_RDMD", source: "file", file, ring: "none" });
  });
});
