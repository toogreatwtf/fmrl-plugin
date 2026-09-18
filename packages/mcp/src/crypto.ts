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

/** openEnvelope decrypts a v2 kdf-none envelope with its key. Used by tests; the plugin never reads pages. */
export async function openEnvelope(envelope: string, opts: { key: string }): Promise<string> {
  if (!envelope.startsWith("MARKYENC")) throw new Error("not an envelope");
  const env = JSON.parse(envelope.slice("MARKYENC".length)) as { v: number; alg: string; kdf: string; nonce: string; data: string };
  if (env.v !== 2 || env.alg !== "aes-256-gcm") throw new Error("unsupported envelope");
  if (env.kdf !== "none") throw new Error(`unsupported envelope: kdf must be none, got ${env.kdf}`);
  const key = await subtle.importKey("raw", unb64url(opts.key), "AES-GCM", false, ["decrypt"]);
  const plain = await subtle.decrypt({ name: "AES-GCM", iv: unb64(env.nonce) }, key, unb64(env.data));
  return new TextDecoder().decode(plain);
}
