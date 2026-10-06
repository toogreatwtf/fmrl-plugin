import { describe, expect, it } from "vitest";
import type { CredentialsFile } from "../src/credentials.js";
import { newRing } from "../src/crypto.js";
import { batchVaultRings, collectVaultRings } from "../src/vault-sync.js";

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
