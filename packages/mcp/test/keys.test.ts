import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FmrlApi } from "../src/api.js";
import { readCredentials, writeCredentials } from "../src/credentials.js";
import { KeyStore } from "../src/keys.js";
import { startFakeApi, type FakeApi } from "./fake-api.js";

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
});

describe("KeyStore rings", () => {
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
