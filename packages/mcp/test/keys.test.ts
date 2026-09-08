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
});
