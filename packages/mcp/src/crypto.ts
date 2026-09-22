// Sealer for private pages. The same envelope static/fmrl.js produces in the
// browser: MARKYENC + JSON, AES-256-GCM under one random key per page (kdf
// "none"), the key handed out as 43 base64url characters in the link's
// fragment or on its own. Node 20 exposes WebCrypto as globalThis.crypto.

const subtle = globalThis.crypto.subtle;

export interface Sealed { envelope: string; key: string }

function b64(bytes: Uint8Array): string { return Buffer.from(bytes).toString("base64"); }
// Uint8Array<ArrayBuffer>, not the plain Uint8Array default of Uint8Array<ArrayBufferLike>:
// WebCrypto's BufferSource type requires the narrower ArrayBuffer-backed view.
function unb64(s: string): Uint8Array<ArrayBuffer> { return new Uint8Array(Buffer.from(s, "base64")) as Uint8Array<ArrayBuffer>; }
function b64url(bytes: Uint8Array): string { return Buffer.from(bytes).toString("base64url"); }
function unb64url(s: string): Uint8Array<ArrayBuffer> { return new Uint8Array(Buffer.from(s, "base64url")) as Uint8Array<ArrayBuffer>; }

/** seal encrypts a complete HTML document under a fresh random key and returns the key (43 base64url chars) for the link's fragment. */
export async function seal(html: string): Promise<Sealed> {
  if (html.length === 0) throw new Error("nothing to encrypt");
  const nonce = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const rawKey = globalThis.crypto.getRandomValues(new Uint8Array(32));
  const key = await subtle.importKey("raw", rawKey, "AES-GCM", false, ["encrypt"]);
  const data = new Uint8Array(await subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, new TextEncoder().encode(html)));
  const env = { v: 2, alg: "aes-256-gcm", kdf: "none", salt: "", nonce: b64(nonce), data: b64(data) };
  return { envelope: "MARKYENC" + JSON.stringify(env), key: b64url(rawKey) };
}

/** openEnvelope decrypts a v2 kdf-none envelope with its key; it rejects for the wrong key, which is how a candidate key is proved. */
export async function openEnvelope(envelope: string, opts: { key: string }): Promise<string> {
  if (!envelope.startsWith("MARKYENC")) throw new Error("not an envelope");
  const env = JSON.parse(envelope.slice("MARKYENC".length)) as { v: number; alg: string; kdf: string; nonce: string; data: string };
  if (env.v !== 2 || env.alg !== "aes-256-gcm") throw new Error("unsupported envelope");
  if (env.kdf !== "none") throw new Error(`unsupported envelope: kdf must be none, got ${env.kdf}`);
  const key = await subtle.importKey("raw", unb64url(opts.key), "AES-GCM", false, ["decrypt"]);
  const plain = await subtle.decrypt({ name: "AES-GCM", iv: unb64(env.nonce) }, key, unb64(env.data));
  return new TextDecoder().decode(plain);
}

// ---------------------------------------------------------- sealed record
// A private page's key and title, sealed under a ring: 32 random bytes (43
// base64url characters) kept beside the API key in credentials.json and
// handed to a browser only in the fragment of a link (#r=). The wire form is
// base64url(nonce[12] || AES-256-GCM(ring, nonce, JSON {"k","t"})), unpadded,
// no additional data, at most 1024 bytes decoded: the shape markymd's
// internal/crypto/sealed.go validates and static/fmrl.js seals and opens.
// test/fixtures/sealed.json is a byte-for-byte copy of the server's
// internal/crypto/testdata/sealed.json, and all three open it.

/** MAX_SEALED_RECORD is the server's crypto.MaxSealedRecord: a record's decoded size, at most. */
export const MAX_SEALED_RECORD = 1024;
// A nonce, a tag and a two-byte JSON object at the least.
const MIN_SEALED_RECORD = 12 + 16 + 2;
const RING_SHAPE = /^[A-Za-z0-9_-]{43}$/;
/** PAGE_KEY_SHAPE is a private page's content key: 43 base64url characters, the same shape a ring has. */
export const PAGE_KEY_SHAPE = /^[A-Za-z0-9_-]{43}$/;

/** OpenedRecord is what a sealed record holds: the page's content key and its title. */
export interface OpenedRecord { key: string; title: string }

/** isRing reports whether s has a ring's shape: 43 base64url characters. */
export function isRing(s: unknown): s is string {
  return typeof s === "string" && RING_SHAPE.test(s);
}

/** newRing mints a ring: 32 random bytes as 43 base64url characters. */
export function newRing(): string {
  return b64url(globalThis.crypto.getRandomValues(new Uint8Array(32)));
}

async function ringKey(ring: string, use: KeyUsage): Promise<CryptoKey> {
  if (!isRing(ring)) throw new Error("A key ring is 43 base64url characters.");
  return subtle.importKey("raw", unb64url(ring), "AES-GCM", false, [use]);
}

/**
 * sealRecord seals a private page's key and title under ring. The title is
 * cut to 200 code points, so a surrogate pair is never split, as the
 * browser cuts it; a record over MAX_SEALED_RECORD bytes is refused, as Go's
 * SealRecord refuses it (a title whose characters JSON escapes six bytes
 * apiece can get there).
 */
export async function sealRecord(ring: string, key: string, title: string): Promise<string> {
  const plain = new TextEncoder().encode(JSON.stringify({ k: key, t: Array.from(title).slice(0, 200).join("") }));
  const nonce = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await subtle.encrypt({ name: "AES-GCM", iv: nonce }, await ringKey(ring, "encrypt"), plain));
  const out = new Uint8Array(nonce.length + ct.length);
  out.set(nonce, 0);
  out.set(ct, nonce.length);
  if (out.length > MAX_SEALED_RECORD) {
    throw new Error(`This page's sealed key would be ${out.length} bytes, over the ${MAX_SEALED_RECORD}-byte limit; pass a shorter title.`);
  }
  return b64url(out);
}

/**
 * openRecord opens a record sealed under ring. It rejects for the wrong
 * ring, a string that is not unpadded base64url, a size outside the shape,
 * or plaintext that is not a record with a 43-character key; a caller
 * treats any of them as a page whose key it does not hold.
 */
export async function openRecord(ring: string, sealed: string): Promise<OpenedRecord> {
  if (!/^[A-Za-z0-9_-]+$/.test(sealed)) throw new Error("not a sealed record");
  const bytes = unb64url(sealed);
  if (bytes.length < MIN_SEALED_RECORD || bytes.length > MAX_SEALED_RECORD) throw new Error("not a sealed record");
  const plain = await subtle.decrypt({ name: "AES-GCM", iv: bytes.subarray(0, 12) }, await ringKey(ring, "decrypt"), bytes.subarray(12));
  const rec = JSON.parse(new TextDecoder().decode(plain)) as { k?: unknown; t?: unknown } | null;
  if (!rec || typeof rec.k !== "string" || !PAGE_KEY_SHAPE.test(rec.k)) throw new Error("not a sealed record");
  return { key: rec.k, title: typeof rec.t === "string" ? rec.t : "" };
}
