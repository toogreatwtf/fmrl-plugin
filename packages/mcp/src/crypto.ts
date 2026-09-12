// Sealer for private pages. The same envelope static/fmrl.js produces in the
// browser: MARKYENC + JSON, AES-256-GCM, a random link key (kdf "none") or a
// PBKDF2 key from a passphrase. Node 20 exposes WebCrypto as globalThis.crypto.

const subtle = globalThis.crypto.subtle;
const PBKDF2_ITERATIONS = 600000;

export interface Sealed { envelope: string; key: string | null }

function b64(bytes: Uint8Array): string { return Buffer.from(bytes).toString("base64"); }
// Uint8Array<ArrayBuffer>, not the plain Uint8Array default of Uint8Array<ArrayBufferLike>:
// WebCrypto's BufferSource type requires the narrower ArrayBuffer-backed view.
function unb64(s: string): Uint8Array<ArrayBuffer> { return new Uint8Array(Buffer.from(s, "base64")) as Uint8Array<ArrayBuffer>; }
function b64url(bytes: Uint8Array): string { return Buffer.from(bytes).toString("base64url"); }
function unb64url(s: string): Uint8Array<ArrayBuffer> { return new Uint8Array(Buffer.from(s, "base64url")) as Uint8Array<ArrayBuffer>; }

async function keyFromPassphrase(passphrase: string, salt: Uint8Array<ArrayBuffer>, usage: KeyUsage): Promise<CryptoKey> {
  const base = await subtle.importKey("raw", new TextEncoder().encode(passphrase), "PBKDF2", false, ["deriveKey"]);
  return subtle.deriveKey({ name: "PBKDF2", hash: "SHA-256", salt, iterations: PBKDF2_ITERATIONS }, base, { name: "AES-GCM", length: 256 }, false, [usage]);
}

/** seal encrypts a complete HTML document. Without a passphrase the returned key (43 base64url chars) goes in the link's fragment as p=. */
export async function seal(html: string, passphrase?: string): Promise<Sealed> {
  if (html.length === 0) throw new Error("nothing to encrypt");
  const nonce = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const salt = passphrase ? globalThis.crypto.getRandomValues(new Uint8Array(16)) : null;
  const rawKey = passphrase ? null : globalThis.crypto.getRandomValues(new Uint8Array(32));
  const key = passphrase
    ? await keyFromPassphrase(passphrase, salt!, "encrypt")
    : await subtle.importKey("raw", rawKey!, "AES-GCM", false, ["encrypt"]);
  const data = new Uint8Array(await subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, new TextEncoder().encode(html)));
  const env = { v: 2, alg: "aes-256-gcm", kdf: passphrase ? "pbkdf2" : "none", salt: salt ? b64(salt) : "", nonce: b64(nonce), data: b64(data) };
  return { envelope: "MARKYENC" + JSON.stringify(env), key: rawKey ? b64url(rawKey) : null };
}

/** openEnvelope decrypts a v2 envelope with a link key or a passphrase. Used by tests; the plugin never reads pages. */
export async function openEnvelope(envelope: string, opts: { key?: string; passphrase?: string }): Promise<string> {
  if (!envelope.startsWith("MARKYENC")) throw new Error("not an envelope");
  const env = JSON.parse(envelope.slice("MARKYENC".length)) as { v: number; alg: string; kdf: string; salt: string; nonce: string; data: string };
  if (env.v !== 2 || env.alg !== "aes-256-gcm") throw new Error("unsupported envelope");
  let key: CryptoKey;
  if (env.kdf === "none" && opts.key !== undefined) key = await subtle.importKey("raw", unb64url(opts.key), "AES-GCM", false, ["decrypt"]);
  else if (env.kdf === "pbkdf2" && opts.passphrase !== undefined) key = await keyFromPassphrase(opts.passphrase, unb64(env.salt), "decrypt");
  else throw new Error("wrong kind of key for this envelope");
  const plain = await subtle.decrypt({ name: "AES-GCM", iv: unb64(env.nonce) }, key, unb64(env.data));
  return new TextDecoder().decode(plain);
}
