import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { openEnvelope, seal } from "../src/crypto.js";

const fixture = async () => JSON.parse(await readFile(new URL("./fixtures/v2.json", import.meta.url), "utf8")) as {
  plaintext: string; key: string; passphrase: string; go: { none: string; pbkdf2: string }; js: { none: string; pbkdf2: string };
};

describe("seal", () => {
  it("fragment mode: v2 kdf none, 43-char base64url key, round-trips", async () => {
    const { envelope, key } = await seal("<h1>x</h1>");
    expect(envelope.startsWith('MARKYENC{"v":2,"alg":"aes-256-gcm","kdf":"none","salt":"","nonce":"')).toBe(true);
    expect(key).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await openEnvelope(envelope, { key: key! })).toBe("<h1>x</h1>");
    await expect(openEnvelope(envelope, { key: "A".repeat(43) })).rejects.toThrow();
  });
  it("passphrase mode: v2 kdf pbkdf2 with a 16-byte salt and no key", async () => {
    const { envelope, key } = await seal("<h1>y</h1>", "pw");
    expect(key).toBeNull();
    const env = JSON.parse(envelope.slice("MARKYENC".length));
    expect(env).toMatchObject({ v: 2, alg: "aes-256-gcm", kdf: "pbkdf2" });
    expect(Buffer.from(env.salt, "base64")).toHaveLength(16);
    expect(Buffer.from(env.nonce, "base64")).toHaveLength(12);
    expect(await openEnvelope(envelope, { passphrase: "pw" })).toBe("<h1>y</h1>");
    await expect(openEnvelope(envelope, { passphrase: "no" })).rejects.toThrow();
  });
  it("opens the Go implementation's envelopes", async () => {
    const fx = await fixture();
    expect(await openEnvelope(fx.go.none, { key: fx.key })).toBe(fx.plaintext);
    expect(await openEnvelope(fx.go.pbkdf2, { passphrase: fx.passphrase })).toBe(fx.plaintext);
  });
  it("refuses an empty plaintext", async () => {
    await expect(seal("")).rejects.toThrow();
  });
});
