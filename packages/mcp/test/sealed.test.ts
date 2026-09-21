import { createDecipheriv } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { MAX_SEALED_RECORD, isRing, newRing, openRecord, sealRecord } from "../src/crypto.js";

// fixtures/sealed.json is a byte-for-byte copy of markymd's
// internal/crypto/testdata/sealed.json, sealed by Go. The browser's fmrl.js
// opens the same file under Node from markymd's go test, and this opens it
// with the plugin's code. Never regenerate it here: the point is three
// sealers opening one file.
const fixture = async () => JSON.parse(await readFile(new URL("./fixtures/sealed.json", import.meta.url), "utf8")) as {
  ring: string; record: { k: string; t: string }; sealed: string;
};

describe("sealed records", () => {
  it("opens the Go-sealed fixture under its ring", async () => {
    const fx = await fixture();
    expect(await openRecord(fx.ring, fx.sealed)).toEqual({ key: fx.record.k, title: fx.record.t });
  });
  it("refuses the fixture under another ring", async () => {
    const fx = await fixture();
    await expect(openRecord(newRing(), fx.sealed)).rejects.toThrow();
  });
  it("refuses every wrong shape by rejecting", async () => {
    const fx = await fixture();
    // Empty, not base64url, padded, too short for a nonce and a tag, over 1 KiB decoded.
    for (const bad of ["", "not base64url!", fx.sealed + "=", "AAAA", "A".repeat(1400)]) {
      await expect(openRecord(fx.ring, bad)).rejects.toThrow();
    }
    await expect(openRecord("short", fx.sealed)).rejects.toThrow();
  });
  it("seal then open round-trips the key and the title", async () => {
    const fx = await fixture();
    const title = "Tom & Jerry — \"quotes\" 🙂";
    const sealed = await sealRecord(fx.ring, fx.record.k, title);
    expect(sealed).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(await openRecord(fx.ring, sealed)).toEqual({ key: fx.record.k, title });
  });
  it("seals the layout Go opens: nonce, ciphertext, tag, unpadded base64url, no additional data", async () => {
    // Opened with node:crypto rather than the plugin's own openRecord, the
    // way internal/crypto.OpenRecord reads it: raw[:12] is the nonce, the
    // last 16 bytes are the tag.
    const fx = await fixture();
    const raw = Buffer.from(await sealRecord(fx.ring, fx.record.k, fx.record.t), "base64url");
    const d = createDecipheriv("aes-256-gcm", Buffer.from(fx.ring, "base64url"), raw.subarray(0, 12));
    d.setAuthTag(raw.subarray(raw.length - 16));
    const plain = Buffer.concat([d.update(raw.subarray(12, raw.length - 16)), d.final()]).toString("utf8");
    expect(JSON.parse(plain)).toEqual(fx.record);
  });
  it("cuts a long title to 200 code points without splitting a surrogate pair", async () => {
    const ring = newRing();
    const opened = await openRecord(ring, await sealRecord(ring, "A".repeat(43), "🙂".repeat(300)));
    expect(opened.title).toBe("🙂".repeat(200));
  });
  it("refuses a record over 1024 bytes decoded, as Go's SealRecord does", async () => {
    // 200 control characters JSON-escape to six bytes apiece.
    await expect(sealRecord(newRing(), "A".repeat(43), "\u0001".repeat(200))).rejects.toThrow(`over the ${MAX_SEALED_RECORD}-byte limit`);
  });
  it("mints rings of the ring's shape, each one different", () => {
    const a = newRing();
    expect(isRing(a)).toBe(true);
    expect(Buffer.from(a, "base64url")).toHaveLength(32);
    expect(newRing()).not.toBe(a);
    expect(isRing("A".repeat(42))).toBe(false);
    expect(isRing("A".repeat(42) + "=")).toBe(false);
    expect(isRing(undefined)).toBe(false);
  });
});
