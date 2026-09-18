import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { openEnvelope, seal } from "../src/crypto.js";

const fixture = async () => JSON.parse(await readFile(new URL("./fixtures/v2.json", import.meta.url), "utf8")) as {
  plaintext: string; key: string; go: { none: string }; js: { none: string };
};

describe("seal", () => {
  it("v2 kdf none, a 43-char base64url key, round-trips", async () => {
    const { envelope, key } = await seal("<h1>x</h1>");
    expect(envelope.startsWith('MARKYENC{"v":2,"alg":"aes-256-gcm","kdf":"none","salt":"","nonce":"')).toBe(true);
    expect(key).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await openEnvelope(envelope, { key })).toBe("<h1>x</h1>");
    await expect(openEnvelope(envelope, { key: "A".repeat(43) })).rejects.toThrow();
  });
  it("refuses the shape it no longer seals", async () => {
    const pbkdf2 = "MARKYENC" + JSON.stringify({ v: 2, alg: "aes-256-gcm", kdf: "pbkdf2", salt: "AAAAAAAAAAAAAAAAAAAAAA==", nonce: "AAAAAAAAAAAAAAAA", data: "AAAAAAAAAAAAAAAAAAAAAA==" });
    await expect(openEnvelope(pbkdf2, { key: "A".repeat(43) })).rejects.toThrow(/kdf/);
  });
  it("opens the Go implementation's envelope", async () => {
    const fx = await fixture();
    expect(await openEnvelope(fx.go.none, { key: fx.key })).toBe(fx.plaintext);
    expect((fx.go as Record<string, unknown>).pbkdf2).toBeUndefined();
    expect((fx.js as Record<string, unknown>).pbkdf2).toBeUndefined();
    expect((fx as Record<string, unknown>).passphrase).toBeUndefined();
  });
  it("refuses an empty plaintext", async () => {
    await expect(seal("")).rejects.toThrow();
  });
  it("the fixture's js envelope opens (what the Go test checks too)", async () => {
    const fx = await fixture();
    expect(await openEnvelope(fx.js.none, { key: fx.key })).toBe(fx.plaintext);
  });
});
