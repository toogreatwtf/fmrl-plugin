import { createDecipheriv, createECDH, createPrivateKey, hkdfSync } from "node:crypto";

/** Fixed public test data copied unchanged from the reviewed Go fixture. */
export interface VaultFixture {
  version: number;
  pub: string;
  fingerprint: string;
  private_pkcs8: string;
  vault_key: string;
  prf_output: string;
  recovery_bytes: string;
  recovery_code: string;
  prefix: string;
  ring: string;
  wrapped_priv: string;
  passkey: { id: string; cred_id: string; prf_salt: string; wrap: string };
  recovery: { id: string; wrap: string };
  box: string;
}

// Independent of production sealing: opens the server's fixed layout with
// the fixture's public test private key. Never import this helper from src.
export function openTestVaultBox(fx: VaultFixture, prefix: string, box: string): string {
  const raw = Buffer.from(box, "base64url");
  const jwk = createPrivateKey({ key: Buffer.from(fx.private_pkcs8, "base64url"),
    format: "der", type: "pkcs8" }).export({ format: "jwk" });
  const ecdh = createECDH("prime256v1");
  ecdh.setPrivateKey(Buffer.from(jwk.d!, "base64url"));
  const epk = raw.subarray(0, 65);
  const bk = Buffer.from(hkdfSync("sha256", ecdh.computeSecret(epk), epk, "fmrl ring box v1", 32));
  const dec = createDecipheriv("aes-256-gcm", bk, raw.subarray(65, 77));
  dec.setAAD(Buffer.from(`fmrl ring box v1|${fx.fingerprint}|${prefix}`, "utf8"));
  dec.setAuthTag(raw.subarray(109));
  return Buffer.concat([dec.update(raw.subarray(77, 109)), dec.final()]).toString("base64url");
}
