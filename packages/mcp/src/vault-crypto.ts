import { createCipheriv, createECDH, createHash, ECDH, hkdfSync, randomBytes } from "node:crypto";

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const FINGERPRINT_SHAPE = /^(?:[A-Z2-7]{4} ){6}[A-Z2-7][AEIMQUY4]$/;
const PREFIX_SHAPE = /^fmrl_[A-Za-z0-9]{4}$/;
const BOX_INFO = "fmrl ring box v1";

function decodeCanonical(value: string, size: number, error: string): Buffer {
  if (typeof value !== "string" || value.length !== Math.ceil(size * 8 / 6) ||
      !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error(error);
  const raw = Buffer.from(value, "base64url");
  if (raw.length !== size || raw.toString("base64url") !== value) throw new Error(error);
  return raw;
}

function vaultPublicKey(pub: string): Buffer {
  const raw = decodeCanonical(pub, 65, "invalid vault public key");
  try {
    const normalized = ECDH.convertKey(raw, "prime256v1", undefined, undefined, "uncompressed");
    if (raw[0] !== 4 || typeof normalized === "string" || !normalized.equals(raw)) {
      throw new Error("invalid vault public key");
    }
  } catch {
    // OpenSSL diagnostics can reflect input; expose only this fixed message.
    throw new Error("invalid vault public key");
  }
  return raw;
}

/** A grouped RFC4648 base32 fingerprint, including its final padding bits. */
export function isVaultFingerprint(value: unknown): value is string {
  return typeof value === "string" && value.length === 32 && FINGERPRINT_SHAPE.test(value);
}

/** First 16 SHA-256 bytes of the canonical uncompressed P-256 public key. */
export function vaultFingerprint(pub: string): string {
  const hash = createHash("sha256").update(vaultPublicKey(pub)).digest().subarray(0, 16);
  let encoded = "";
  let value = 0;
  let bits = 0;
  for (const byte of hash) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      encoded += BASE32[(value >>> bits) & 31];
    }
    value &= (1 << bits) - 1;
  }
  if (bits > 0) encoded += BASE32[value << (5 - bits)];
  return encoded.match(/.{1,4}/g)!.join(" ");
}

/** Seal a local ring for a vault; production never holds its private key. */
export function sealVaultRing(pub: string, prefix: string, ring: string): string {
  const fingerprint = vaultFingerprint(pub);
  if (typeof prefix !== "string" || prefix.length !== 9 || !PREFIX_SHAPE.test(prefix)) {
    throw new Error("invalid vault ring prefix");
  }
  const plain = decodeCanonical(ring, 32, "invalid vault ring");
  const recipient = Buffer.from(pub, "base64url");
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  const epk = ecdh.getPublicKey(undefined, "uncompressed");
  const bk = Buffer.from(hkdfSync("sha256", ecdh.computeSecret(recipient), epk, BOX_INFO, 32));
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", bk, nonce);
  cipher.setAAD(Buffer.from(`${BOX_INFO}|${fingerprint}|${prefix}`, "utf8"));
  return Buffer.concat([epk, nonce, cipher.update(plain), cipher.final(), cipher.getAuthTag()]).toString("base64url");
}
