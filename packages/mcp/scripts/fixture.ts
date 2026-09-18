// Prints the plugin's envelope for the shared interop fixture. Run with
// `npx tsx scripts/fixture.ts` (or build and run dist), paste the output into
// test/fixtures/v2.json's "js" block and into the server repo's
// internal/crypto/testdata/v2.json. Both files must keep the same plaintext
// and key.
import { readFile } from "node:fs/promises";

const fx = JSON.parse(await readFile(new URL("../test/fixtures/v2.json", import.meta.url), "utf8")) as { plaintext: string; key: string };
// The fixture's fixed key rather than a random one, so the Go test can open
// it with the same key.
const subtle = globalThis.crypto.subtle;
const key = await subtle.importKey("raw", Buffer.from(fx.key, "base64url"), "AES-GCM", false, ["encrypt"]);
const nonce = globalThis.crypto.getRandomValues(new Uint8Array(12));
const data = new Uint8Array(await subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, new TextEncoder().encode(fx.plaintext)));
const none = "MARKYENC" + JSON.stringify({ v: 2, alg: "aes-256-gcm", kdf: "none", salt: "", nonce: Buffer.from(nonce).toString("base64"), data: Buffer.from(data).toString("base64") });
console.log(JSON.stringify({ none }, null, 2));
