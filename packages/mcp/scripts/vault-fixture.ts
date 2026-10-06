import { readFile } from "node:fs/promises";
import { sealVaultRing } from "../src/vault-crypto.js";
import type { VaultFixture } from "../test/support/vault.js";

// Generates a fresh box only from reviewed public test data; never rewrites
// the Go fixture or reads the user's credentials.
const fx = JSON.parse(await readFile(new URL("../test/fixtures/vault.json", import.meta.url), "utf8")) as VaultFixture;
console.log(JSON.stringify({ prefix: fx.prefix, box: sealVaultRing(fx.pub, fx.prefix, fx.ring) }, null, 2));
