## Final-review controller amendment (2026-10-06; supersedes earlier upload rules)

- Export only same-origin stored keys and history with locally recorded `ring_origins[slot]` provenance. Canonicalize HTTP(S) URL aliases. Unscoped legacy history stays on disk and is excluded unless its exact prefix/ring pair is present in a same-origin stored key; a matching prefix or server eligibility claim alone proves nothing. Never assume fmrl.site for unscoped history. New history filing records provenance without relabeling legacy entries.
- Upload only the actual active file ring for the active prefix, in its own first request. Superseded variants for that prefix remain local and are not requested: uploading every variant is waived because the server retains only one box per prefix. This protects the active ring even with pathological same-prefix history. An environment-only or different override excludes stale active-prefix file variants and omits the status claim; an equal override can qualify by exact pair equality.
- Other eligible prefixes retain numeric historical order, configured-key variant last. Use batches of up to 50 distinct prefixes. On atomic HTTP 400 rejection, try each member of a multi-row batch once separately, continue other prefixes, and keep aggregate status unknown if any batch was refused. A singleton 400 is not retried. All other failures stop the pass; honor 429 immediately and never retry network/5xx failures. Bound the pass to 60 PUT attempts, return unknown if unfinished, and start afresh on the next tool call. The active request costs one edit; a refused N-row batch costs at most 1+N requests, within the pass cap and shared default 60/hour edit budget.
- Keep the existing empty PUT for an empty collection, but it cannot establish synced status. Synced requires successful upload of the actual active ring and no requested-scope refusal. Approved copy is unchanged. Controller clarification: an unavailable vault (absent advertisement or initial 403/409) may still use the truthful approved not-synced line, including with an environment override; omit success claims based only on empty or stale file uploads.
- Reduced recovery coverage: unknown-origin legacy rings are not exported; superseded active-prefix rings remain local. Neither can be described as account-backed-up. No server/API schema changes and no loss of locally saved history.

Earlier task code snippets are historical implementation guidance; the rules above replace their enumeration/coordinator behavior.

# fmrl ring sync PR 3 — Plugin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Seal the machine's stored rings to its account vault after every successful publish and on every `fmrl_whoami`, with a persistent origin pin and explicit confirmation of a changed vault.

**Architecture:** Keep production cryptography in a small seal-only Node module; keep credential mutations inside `KeyStore`'s existing queue; coordinate fresh `/me` reads and sequential ring uploads in a separate sync module. The local MCP server renders approved copy without exposing vault payloads and remains compatible with servers that omit `account_vault`.

**Tech Stack:** TypeScript, Node >=20, built-in `node:crypto`, existing Vitest and MCP SDK/Zod. No new dependency.

**Spec:** Read both `/Users/martymulligan/.codex/worktrees/486a/main/docs/superpowers/specs/2026-10-06-fmrl-ring-sync-design.md` and the adjacent `2026-10-06-fmrl-ring-sync-copy.html`, plus `/Users/martymulligan/.codex/worktrees/486a/main/docs/superpowers/prompts/2026-10-06-fmrl-ring-sync-kickoff.md`. These approved files are in markymd; this plugin plan does not replace them. The spec's *Resolved review items* overrides earlier prose. PR1 wire clarification/fixture comes from markymd commit `ca28df253f8ecc24e22f3f9a46c2018b95e6b025`, `internal/crypto/testdata/vault.json` and `.superpowers/sdd/2026-10-06-fmrl-ring-sync-pr1/{global-contract,task-1-report}.md` in `/Users/martymulligan/.codex/worktrees/fmrl-ring-sync-pr1/main`.

## Global Constraints

- Plugin repo `toogreatwtf/fmrl-plugin`, base `main`; isolated checkout `/private/tmp/fmrl-ring-sync-pr3`, branch `codex/fmrl-ring-sync-pr3`, starting main `3668be47ffce3809a3cb3a18df8e24d284e604b7`. No other agent/session works in this checkout. Root controller dispatches execution/reviews after this plan commit.
- No AGENTS.md or CLAUDE.md exists in this plugin checkout at that starting commit. Read README's Development/Keys sections, existing source/tests and `.github/workflows/{test,release}.yml` as the current contracts. Task-observer is active; no observation log exists here, so do not create one without opt-in.
- The server never receives a ring, a vault key, a vault private key, a recovery code or a PRF output. Production plugin only seals boxes; opening belongs exclusively to test code.
- Nothing about the vault goes through `/mcp`. App keys have no ring. This PR touches the local plugin MCP implementation only; no hosted MCP or markymd changes.
- `credentials.json` remains `version: 1`, with additive `vault_pins: {[origin]: fingerprint}`. Origin means `new URL(api.viewerBase).origin`, not path, key prefix or account ID. Unknown credential fields and all existing rings survive writes.
- Every successful public/private `fmrl_publish` and `fmrl_publish_file` performs a fresh `GET /api/v1/me` after publishing, then uploads when a vault is advertised; every `fmrl_whoami` also syncs. No throttle, boxed-ring cache, background timer or retry loop. An empty ring collection still sends one `{boxes: []}` PUT when a valid pinned vault exists.
- Ring PUTs contain at most **50** boxes and no repeated prefix. PR1 shares `API.EditLimiter` with edits, `API_EDITS_PER_HOUR`, default **60/hour**, keyed by bearer key ID. This does not consume publish quota. Stop on operational refusals; isolate atomic 400s within the 60-attempt cap as amended above. The next authorized tool call tries afresh.
- Fingerprint = first **16 bytes** of SHA-256 of the decoded **65-byte** uncompressed P-256 public key, uppercase **RFC4648** base32 without padding: 26 characters, six groups of four and a final two, separated by ASCII spaces. The grouped string is also used in ring-box AD. Recovery uses Crockford base32; the plugin never creates or accepts recovery codes.
- Ring box = unpadded canonical base64url of `epk[65] || nonce[12] || ciphertext[32] || tag[16]`, exactly **125 bytes**. BK = HKDF-SHA256(ECDH(ephemeral private, vault public), salt=epk, info=`fmrl ring box v1`, length=32). AD = `fmrl ring box v1|` + grouped fingerprint + `|` + prefix.
- Validate served pub and recompute its fingerprint before pinning or sealing. Refuse noncanonical base64url, a bad point, a mismatched supplied fingerprint or invalid ring/prefix. New diagnostics are fixed strings: never append raw errors, account IDs, prefixes, pub, boxes, wraps, key material or file contents.
- Copy screens 10–11 are verbatim, replacing illustrative fingerprints with the actual canonical grouped values. No new user-facing prose. A malformed vault, local persistence failure, 429/network/5xx or partial upload is **operational unknown**: preserve the original tool success, omit any synced/not-synced claim, and log one fixed non-secret line. PUT 403/409 is silent. A primary whoami `/me` failure still follows existing error/revocation behavior.
- Existing browser links intentionally carry `#r=` and private viewer links carry `#p=`; preserve that established behavior. No new standalone ring, box, VK, vault pub/private data or credential content enters tool text/structured results. Explicitly remove `account_vault` before spreading `/me` into output.
- All tasks use TDD: tests first, run RED, explain the precise missing behavior, implement, run GREEN, commit. A setup/fixture/socket failure is not behavioral RED. Full `npm test` and `npm run build` precede opening the draft PR; CI Node 20 and 22 must pass before ready. Read-only overlap check on 2026-10-06 found no open plugin PRs; repeat before PR creation.
- Implementation, not this plan-only commit, bumps package/lock/manifest from 0.14.0 to **0.15.0** (reassess if origin/main advances). Marty merges; merging the version bump triggers npm release. Do not merge, publish to npm, access Cloudflare/OpenRouter tokens or mutate installed plugin caches.

## Historical-ring limitation and proposed spec clarification

`KeyStore.fileRing` preserves historical variants and their known local origins. Unknown-origin legacy history is excluded from export unless an exact pair has same-origin stored-key evidence. PR1 retains one box per prefix: only the actual eligible active file ring is requested for the active prefix, first; superseded variants remain local. Other prefixes retain numeric history followed by stored-key variants. Account unlock recovers the final stored variant, not every historical ring. Do not describe sync as a complete credentials-file backup. This controller-approved departure from upload-every reduces transmitted historical coverage without reducing the server's one-box recoverability.

## File map and stable interfaces

Create `packages/mcp/src/vault-crypto.ts` (canonical pub/fingerprint and seal-only crypto), `src/vault-sync.ts` (enumeration, batching, pin/upload state), `test/vault-crypto.test.ts`, `test/vault-sync.test.ts`, `test/support/vault.ts` (independent test-only opener), `test/fixtures/vault.json` (unchanged reviewed Go fixture), `scripts/vault-fixture.ts` (prints a Node-produced box for cross-client testing).

Modify `src/credentials.ts` (typed/sanitized pins), `src/keys.ts` (serialized snapshot/pin methods), `src/api.ts` (wire types and PUT), `src/server.ts` (publish/whoami integration and approved copy), `test/{credentials,keys,api,server}.test.ts`, `test/fake-api.ts`, README.md, packages/mcp/README.md, `plugins/fmrl/skills/whoami/SKILL.md`, and the three version files in the release task.

```ts
// vault-crypto.ts; synchronous Node crypto; throws fixed errors only.
export function isVaultFingerprint(value: unknown): value is string;
export function vaultFingerprint(pub: string): string;
export function sealVaultRing(pub: string, prefix: string, ring: string): string;

// api.ts
export interface AccountVault { pub: string; fingerprint: string }
export interface RingBoxInput { prefix: string; box: string }
// MeResponse gains account_vault?: AccountVault
// FmrlApi gains putRings(key: string, boxes: RingBoxInput[]): Promise<{stored: number}>

// keys.ts: methods use this.serialize, never a separate file-write queue.
export type VaultPinResult =
  | { kind: "accepted"; first: boolean }
  | { kind: "changed"; previous: string }
  | { kind: "invalid-trust" };
// KeyStore.vaultSnapshot(): Promise<CredentialsFile>
// KeyStore.pinVault(origin: string, fingerprint: string, trust?: string): Promise<VaultPinResult>

// vault-sync.ts
export interface LocalVaultRing { prefix: string; ring: string }
export function collectVaultRings(file: CredentialsFile, baseUrl: string): LocalVaultRing[];
export function batchVaultRings(rings: LocalVaultRing[]): LocalVaultRing[][];
export type VaultSyncResult =
  | { state: "none"; fingerprint?: string; firstPin?: boolean }
  | { state: "changed"; previous: string; fingerprint: string }
  | { state: "synced"; fingerprint: string; firstPin: boolean }
  | { state: "unknown"; fingerprint?: string; firstPin: boolean };
export interface VaultSyncOptions { api: FmrlApi; keys: KeyStore; log?: (line: string) => void }
export class VaultSync {
  constructor(options: VaultSyncOptions);
  sync(key: string, options?: { me?: MeResponse; trust?: string }): Promise<VaultSyncResult>;
}
```

`VaultSync` has its own operation queue for whole sync passes, while file mutations remain on `KeyStore`'s queue. `me`, if supplied by whoami, is that invocation's fresh response; never reuse a previous invocation's `/me`. On publish omit it so a fresh GET happens after publish succeeds. Rejected `trust` must never repin. No pin plus a mismatching supplied `trust` returns invalid-trust/unknown without writing.

---

### Task 1: Canonical vault crypto and reviewed cross-client fixture

**Files:** Create `src/vault-crypto.ts`, `test/vault-crypto.test.ts`, `test/support/vault.ts`, `test/fixtures/vault.json`, `scripts/vault-fixture.ts` under `packages/mcp`.

**Interfaces:** Consumes reviewed JSON's `pub`, `fingerprint`, `private_pkcs8`, `prefix`, `ring`, `box`; produces `isVaultFingerprint`, `vaultFingerprint`, `sealVaultRing`, and test-only `openTestVaultBox(fx: VaultFixture, prefix: string, box: string): string`, where `VaultFixture` is the reviewed JSON type including public fixed test secrets. Never export an opener from `src`.

- [ ] **Step 1: Copy the fixture unchanged and write independent opening tests before production code.** From repo root:

```bash
git -C /Users/martymulligan/.codex/worktrees/fmrl-ring-sync-pr1/main show ca28df253f8ecc24e22f3f9a46c2018b95e6b025:internal/crypto/testdata/vault.json > packages/mcp/test/fixtures/vault.json
```

Use this independent test helper, not the sealer's implementation, to open both Go and plugin boxes:

```ts
import { createDecipheriv, createECDH, createPrivateKey, hkdfSync } from "node:crypto";
export interface VaultFixture {
  version: number; pub: string; fingerprint: string; private_pkcs8: string;
  prefix: string; ring: string; box: string;
}
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
```

The test imports `fx` via `readFile(new URL("./fixtures/vault.json", import.meta.url))` and has these assertions:

```ts
it("opens Go's box and derives the exact grouped fingerprint", () => {
  expect(openTestVaultBox(fx, fx.prefix, fx.box)).toBe(fx.ring);
  expect(vaultFingerprint(fx.pub)).toBe("NGF6 UY64 ISRU IZR7 6FBJ V2QQ QQ");
});
it("seals the layout opened independently and binds prefix and fingerprint", () => {
  const box = sealVaultRing(fx.pub, fx.prefix, fx.ring);
  expect(Buffer.from(box, "base64url")).toHaveLength(125);
  expect(openTestVaultBox(fx, fx.prefix, box)).toBe(fx.ring);
  expect(() => openTestVaultBox(fx, "fmrl_else", box)).toThrow();
  expect(() => openTestVaultBox({ ...fx, fingerprint: fx.fingerprint.replace("N", "A") }, fx.prefix, box)).toThrow();
  expect(sealVaultRing(fx.pub, fx.prefix, fx.ring)).not.toBe(box);
});
it("rejects malformed public keys without reflecting input", () => {
  for (const bad of ["", fx.pub + "=", fx.pub + "\n", "A".repeat(87), fx.pub.slice(0, -1) + "V"]) {
    expect(() => vaultFingerprint(bad)).toThrow("invalid vault public key");
  }
  expect(isVaultFingerprint(fx.fingerprint)).toBe(true);
  expect(isVaultFingerprint("K7QM 2XDA 9TRV HB3E")).toBe(false);
  expect(() => sealVaultRing(fx.pub, "fmrl_test.2", fx.ring)).toThrow();
  expect(() => sealVaultRing(fx.pub, fx.prefix, "A".repeat(43) + "=")).toThrow();
});
```

Add cases mutating nonce, ciphertext/tag and using a foreign private key to the independent opener; ensure noncanonical trailing-bit rejection actually decodes to the same bytes under permissive Buffer before asserting refusal. `pub` invalid point case must have correct size/uncompressed marker, so it exercises curve validation.

- [ ] **Step 2: Run RED.** `cd packages/mcp && npm test -- test/vault-crypto.test.ts`. Expected missing `vault-crypto.ts` exports, not a missing fixture/helper. Report that reason.
- [ ] **Step 3: Implement seal-only crypto.** Validate encoded lengths/alphabet/re-encoding before use. Validate prefix with `/^fmrl_[A-Za-z0-9]{4}$/`; validate ring's decoded length 32 and canonical encoding (do not rely solely on existing `isRing`'s shape). Validate the 65-byte pub with `ECDH.convertKey(raw, "prime256v1", undefined, undefined, "uncompressed")` and equality; catch OpenSSL errors and replace them with `Error("invalid vault public key")`. Encode fingerprint from SHA-256 truncated bytes with alphabet `ABCDEFGHIJKLMNOPQRSTUVWXYZ234567`, using six four-letter groups and final two. `isVaultFingerprint` additionally enforces final base32 padding bits with final character `[AEIMQUY4]`.

Sealer body after these fixed-error checks:

```ts
const fingerprint = vaultFingerprint(pub);
const recipient = Buffer.from(pub, "base64url");
const ecdh = createECDH("prime256v1");
ecdh.generateKeys();
const epk = ecdh.getPublicKey(undefined, "uncompressed");
const bk = Buffer.from(hkdfSync("sha256", ecdh.computeSecret(recipient), epk, "fmrl ring box v1", 32));
const nonce = randomBytes(12);
const cipher = createCipheriv("aes-256-gcm", bk, nonce);
cipher.setAAD(Buffer.from(`fmrl ring box v1|${fingerprint}|${prefix}`, "utf8"));
return Buffer.concat([epk, nonce, cipher.update(Buffer.from(ring, "base64url")),
  cipher.final(), cipher.getAuthTag()]).toString("base64url");
```

Use built-ins only. `scripts/vault-fixture.ts` reads the unchanged JSON, imports `sealVaultRing`, and prints `JSON.stringify({prefix: fx.prefix, box: sealVaultRing(fx.pub, fx.prefix, fx.ring)}, null, 2)`; this is public test fixture output only. Never regenerate the reviewed fixture in normal tests or rewrite it with random Node data.
- [ ] **Step 4: Run GREEN.** `npm test -- test/vault-crypto.test.ts test/sealed.test.ts && npm run typecheck`; compare fixture bytes with the committed Go fixture using `cmp`. Open Node-generated box with PR1's Go test helper in a temporary Go test in that separate worktree only through the controller; report Node independent-opening proof now, retain cross-client proof as final gate.
- [ ] **Step 5: Commit.** `git add packages/mcp/src/vault-crypto.ts packages/mcp/test/vault-crypto.test.ts packages/mcp/test/support/vault.ts packages/mcp/test/fixtures/vault.json packages/mcp/scripts/vault-fixture.ts && git commit -m "feat: seal account vault ring boxes with portable crypto"`.

### Task 2: Durable origin pins, complete enumeration and deterministic batches

**Files:** Modify `src/credentials.ts`, `src/keys.ts`, `test/credentials.test.ts`, `test/keys.test.ts`; create enumeration/batching parts of `src/vault-sync.ts` and `test/vault-sync.test.ts` under `packages/mcp`.

**Interfaces:** Consumes Task1 fingerprint validation and existing `CredentialsFile`, `KeyStore.serialize`, `readCredentials`/`writeCredentials`; produces `VaultPinResult`, `vaultSnapshot`, `pinVault`, `LocalVaultRing`, `collectVaultRings`, `batchVaultRings` exactly as above. `baseUrl` remains the credential keys-map lookup; origin is only for pins.

- [ ] **Step 1: Write tests for pin persistence and actual upload ordering.** In existing credential test harness, write a v1 file with keys, rings, valid pins, invalid pin values, an array pins value, and an unrelated extension field. Assert read sanitizes only pins/rings and round-trips all other material. Validate same-origin URLs with different paths share a pin; preview and production do not.

```ts
it("keeps each ring variant and sends the active ring last", () => {
  const rings = [newRing(), newRing(), newRing(), newRing()];
  const file: CredentialsFile = { version: 1, keys: {
    "https://fmrl.site": { key: "fmrl_test" + "x".repeat(28), prefix: "fmrl_test", ring: rings[3] },
  }, rings: { "fmrl_test.10": rings[2], "fmrl_test.2": rings[1], fmrl_test: rings[0] } };
  const list = collectVaultRings(file, "https://fmrl.site");
  expect(list).toEqual(rings.map(ring => ({ prefix: "fmrl_test", ring })));
  expect(batchVaultRings(list)).toEqual(list.map(row => [row]));
});
it("splits 51 unique prefixes without dropping any", () => {
  const rows = Array.from({ length: 51 }, (_, n) => ({
    prefix: `fmrl_${String(n).padStart(4, "0")}`, ring: newRing(),
  }));
  const batches = batchVaultRings(rows);
  expect(batches.map(b => b.length)).toEqual([50, 1]);
  expect(batches.flat()).toEqual(rows);
  expect(batchVaultRings([])).toEqual([[]]);
});
```

Extend the first test with duplicate exact `(prefix,ring)` entries, other stored keys/origins, missing legacy stored prefix (`key.slice(0,9)` fallback), revoked-key historical entries and malformed values. Exact pair duplicates may collapse; different rings sharing a prefix must all survive. `file.keys` rings from foreign origins are excluded, as are unscoped legacy variants lacking exact same-origin stored-key evidence. Numeric variants survive local enumeration, but the coordinator uploads only the actual active variant for the active prefix, first, under the final-review controller ruling. Same-prefix matches from other origins never establish export eligibility.

Use an existing KeyStore harness with `file` and `api` to test:

```ts
expect(await keys.pinVault("https://fmrl.site", fx.fingerprint)).toEqual({ kind: "accepted", first: true });
expect(await keys.pinVault("https://fmrl.site", fx.fingerprint)).toEqual({ kind: "accepted", first: false });
// otherFingerprint is computed from a second generated valid P-256 pub using vaultFingerprint.
expect(await keys.pinVault("https://fmrl.site", otherFingerprint)).toEqual({ kind: "changed", previous: fx.fingerprint });
expect(await keys.pinVault("https://fmrl.site", otherFingerprint, fx.fingerprint)).toEqual({ kind: "changed", previous: fx.fingerprint });
expect(await keys.pinVault("https://fmrl.site", otherFingerprint, otherFingerprint)).toEqual({ kind: "accepted", first: false });
expect((await readCredentials(file)).vault_pins).toEqual({ "https://fmrl.site": otherFingerprint });
```

A wrong trust with no existing pin must return `{kind:"invalid-trust"}` and write no pin. Include concurrent `pinVault`/`ringFor`/`adopt` calls and assert rings/keys/pins all survive, leveraging the actual queue. Simulated filesystem write failure prevents upload in Task3. On non-Windows verify 0600 file/0700 directory remains.
- [ ] **Step 2: Run RED.** `npm test -- test/credentials.test.ts test/keys.test.ts test/vault-sync.test.ts`. Explain missing methods/enumeration and assertions that would otherwise lose history.
- [ ] **Step 3: Implement additive sanitization and queued methods.** Add `vault_pins?: Record<string,string>`. `readCredentials` destructures `vault_pins` as well as rings and reconstructs valid canonical origin/string pairs; malformed values are discarded without reflecting them into diagnostics. Do not add a file version or move-aside valid files solely for malformed additive pins.

```ts
vaultSnapshot(): Promise<CredentialsFile> {
  return this.serialize(() => readCredentials(this.o.file));
}
pinVault(origin: string, fingerprint: string, trust?: string): Promise<VaultPinResult> {
  return this.serialize(async () => {
    const file = await readCredentials(this.o.file);
    const previous = file.vault_pins?.[origin];
    if (previous === fingerprint) return { kind: "accepted", first: false };
    if (previous && trust !== fingerprint) return { kind: "changed", previous };
    if (!previous && trust !== undefined && trust !== fingerprint) return { kind: "invalid-trust" };
    file.vault_pins = { ...file.vault_pins, [origin]: fingerprint };
    await writeCredentials(this.o.file, file);
    return { kind: "accepted", first: previous === undefined };
  });
}
```

Validate origin and fingerprint at method boundary using fixed errors. `vaultSnapshot`/`pinVault` should use `readCredentials(this.o.file)` with **no** log callback in vault paths: its existing move-aside diagnostic includes filesystem/error details. The surrounding sync catches failure and emits the one fixed vault diagnostic; preserve existing diagnostics for existing non-vault key operations.

Enumeration: sort ring names by stripped prefix, then suffix numeric ascending (`fmrl_test`, `.2`, `.10`); strip only a terminal `.[2-9][0-9]*` or `.1[0-9]+` suffix. Validate canonical ring and prefix; malformed entries are ignored, not uploaded. Add only same-origin stored keys' valid rings sorted by base URL, with the configured key last. Historical rows require local origin provenance or an exact same-origin stored-key pair; see final-review amendment. Deduplicate identical `(prefix,ring)` by keeping its **last** occurrence so an active-ring duplicate stays promoted last. Ring equality alone does not deduplicate across prefixes. FMRL_RING is never written or added to sync by this task: spec sync scope is credentials-file rings.

Batching is a pure function:

```ts
export function batchVaultRings(rings: LocalVaultRing[]): LocalVaultRing[][] {
  const batches: LocalVaultRing[][] = [];
  let batch: LocalVaultRing[] = [];
  let seen = new Set<string>();
  for (const row of rings) {
    if (batch.length === 50 || seen.has(row.prefix)) {
      batches.push(batch); batch = []; seen = new Set();
    }
    batch.push(row); seen.add(row.prefix);
  }
  if (batch.length || batches.length === 0) batches.push(batch);
  return batches;
}
```

- [ ] **Step 4: Run GREEN.** `npm test -- test/credentials.test.ts test/keys.test.ts test/vault-sync.test.ts && npm run typecheck`.
- [ ] **Step 5: Commit.** Stage these six files and `git commit -m "feat: persist vault pins and enumerate historical rings"`.

### Task 3: API contract and best-effort seal/upload coordinator

**Files:** Modify `src/api.ts`, `test/api.test.ts`, `test/fake-api.ts`, `src/vault-sync.ts`, `test/vault-sync.test.ts` under `packages/mcp`.

**Interfaces:** Consumes Tasks1–2 exports, produces `AccountVault`, `RingBoxInput`, `MeResponse.account_vault`, `FmrlApi.putRings`, and queued `VaultSync.sync`/`VaultSyncResult` as defined. Fake gains `accountVaults: Map<string,AccountVault>` keyed by bearer, `ringBatches: RingBoxInput[][]`, `ringBoxes: Map<string,string>`, and `ringStatus?: number` for controlled refusals; its GET `/me` conditionally adds the map's vault. Tests explicitly share the advertised vault for keys owned by the same fake account.

- [ ] **Step 1: Write HTTP and coordinator tests first.** Extend fake PUT route to check bearer, vault availability, box size/canonical shape, maximum50, duplicate prefixes and atomic refusal before adding batches/last-writer rows. `ringStatus` failures use machine codes and an empty message so no invented UI copy is introduced. Requests already log all bodies for test assertions only, never production logging.

```ts
it("PUTs boxes with the bearer and costs no publish quota", async () => {
  const { key } = await api.mint("x");
  fake.accountVaults.set(key, { pub: fx.pub, fingerprint: fx.fingerprint });
  expect((await api.me(key)).account_vault).toEqual({ pub: fx.pub, fingerprint: fx.fingerprint });
  expect(await api.putRings(key, [{ prefix: fx.prefix, box: fx.box }])).toEqual({ stored: 1 });
  expect(fake.requests.at(-1)).toMatchObject({ method: "PUT", path: "/api/v1/me/rings",
    auth: `Bearer ${key}`, body: { boxes: [{ prefix: fx.prefix, box: fx.box }] } });
  expect((await api.me(key)).quota.publishes.used).toBe(0);
});
```

Coordinator tests create a temp credentials file with stored active ring and history, a fake minted bearer, `new KeyStore(...)` and `new VaultSync({api,keys,log})` (use existing temp/fake teardown patterns). Assert all ciphertexts open independently to the expected ring/prefix and the last `fake.ringBoxes` value opens to the active ring. Test the first pin survives a **new** KeyStore/VaultSync instance; ordinary repeat calls each GET/PUT again; no advertised vault => zero PUT/no pin; pub/fingerprint mismatch => no pin/no seal/no PUT/one fixed log.

```ts
const first = await sync.sync(key);
expect(first).toEqual({ state: "synced", fingerprint: fx.fingerprint, firstPin: true });
const before = fake.requests.length;
expect(await sync.sync(key)).toEqual({ state: "synced", fingerprint: fx.fingerprint, firstPin: false });
expect(fake.requests.slice(before).map(q => [q.method, q.path])).toEqual([
  ["GET", "/api/v1/me"], ["PUT", "/api/v1/me/rings"],
]);
```

Additional concrete cases: changed vault => no PUT, returns `changed` with old/current fingerprints; incorrect/omitted trust stays refused, exact current trust repins/uploads; first pin write failure => no PUT; initial403/409 => none, zero log; 429/network/500 => unknown, exactly one constant log; a first successful batch then a failed second => unknown and no remaining PUTs (including403/409, which still emit no log); all empty rings => one `{boxes:[]}`; 51 distinct prefixes => [50,1]; same-prefix variants => separate sequential PUTs in Task2 order; concurrently invoked syncs are ordered without skipping either; passed `me` causes zero extra GET. Poison API failure `message` with a ring/box/VK and assert none appears in logs. No sync exception should escape to fail a successful publish.
- [ ] **Step 2: Run RED.** `npm test -- test/api.test.ts test/vault-sync.test.ts`. Missing PUT/coordinator APIs or missing pin/upload behavior are expected; describe each RED cause.
- [ ] **Step 3: Add thin API method and coordinator.** `putRings` calls `this.call<{stored:number}>("PUT", "/me/rings", key, {boxes})` and `MeResponse` gains the optional field. Queue each whole `sync` using the existing queue pattern from KeyStore, with rejected jobs leaving the queue usable.

The coordinator executes this order, retaining `firstPin` outside its try/catch:

```ts
let firstPin = false;
let fingerprint: string | undefined;
let completedBatch = false;
try {
  const me = options.me ?? await api.me(key);
  if (me.account_vault === undefined) return { state: "none" };
  const vault = me.account_vault;
  fingerprint = vaultFingerprint(vault.pub);
  if (fingerprint !== vault.fingerprint) throw new Error("invalid vault fingerprint");
  const pin = await keys.pinVault(new URL(api.viewerBase).origin, fingerprint, options.trust);
  if (pin.kind === "changed") return { state: "changed", previous: pin.previous, fingerprint };
  if (pin.kind === "invalid-trust") throw new Error("invalid vault trust");
  firstPin = pin.first;
  const rows = collectVaultRings(await keys.vaultSnapshot(), api.viewerBase);
  for (const batch of batchVaultRings(rows)) {
    const boxes = batch.map(({ prefix, ring }) => ({ prefix, box: sealVaultRing(vault.pub, prefix, ring) }));
    const response = await api.putRings(key, boxes);
    if (response.stored !== boxes.length) throw new Error("incomplete vault sync");
    completedBatch = true;
  }
  return { state: "synced", fingerprint, firstPin };
} catch (e) {
  if (e instanceof ApiError && (e.status === 403 || e.status === 409)) {
    return { state: completedBatch ? "unknown" : "none", fingerprint, firstPin };
  }
  log?.("fmrl-mcp: vault sync failed");
  return { state: "unknown", fingerprint, firstPin };
}
```

Runtime validate vault shape before dereference (`typeof pub/fingerprint === "string"`, non-array object); any malformed advertised value => unknown. All box operations use a snapshot; do not hold KeyStore's file queue across network requests. Do not retry/re-mint the bearer for sync failure after a publish; normal tool auth replacement behavior stays intact. First-pin announcement is independent of whether upload completes; retain its boolean for unknown and silent403/409; approved not-synced plus once-only first-pin can then render honestly.
- [ ] **Step 4: Run GREEN.** `npm test -- test/api.test.ts test/vault-sync.test.ts test/keys.test.ts && npm run typecheck`. Check the production module graph contains no `openTestVaultBox`/private key imports.
- [ ] **Step 5: Commit.** Stage these five files and `git commit -m "feat: sync sealed rings through the account API"`.

### Task 4: Every-publish integration, whoami trust and approved output

**Files:** Modify `packages/mcp/src/server.ts`, `packages/mcp/test/server.test.ts`.

**Interfaces:** Consumes `VaultSync.sync` and result union; produces `fmrl_whoami` optional `trust_vault: string` input, and approved text lines only. Existing eleven tool names and existing output schemas remain. No `account_vault` response passes through to MCP structured results.

- [ ] **Step 1: Add real MCP transport tests before integration.** Use current `connect`, `call`, `text`, fake API and temporary credential helpers, and add a second valid pub/fingerprint generated with Task1 functions. Test no-vault whoami line, successful synced line, first pin exactly once, exact changed copy, correct trust resumes, wrong trust never repins, and no status on operational unknown. A primary revoked whoami key still reports revocation and never mints/uploads.

```ts
const synced = `Private page keys: synced to your fmrl account (vault ${fx.fingerprint}).`;
const noVault = "Private page keys: not synced (this key isn't in an account, or the account hasn't turned on sync).";
const firstPin = `First sync: pinned your account's vault ${fx.fingerprint}. If /account shows a different fingerprint, tell me.`;
// Mint/seed bearer, configure fake.accountVaults, then use the connected client.
const a = await call("fmrl_whoami");
expect(text(a)).toContain(synced);
expect(text(a)).toContain(firstPin);
expect(text(await call("fmrl_whoami"))).not.toContain(firstPin);
expect(a.structuredContent).not.toHaveProperty("account_vault");
```

Capture request offsets after startup/naming and assert each successful public/private inline/file publish has its own post-publish GET and PUT, including a **linked** bearer with no `link_url` (the current early return in `publishAs` must not bypass sync). Two identical publishes and two whoami calls must sync four times. Failed/blank/oversized/denied publishes do not sync. A publish that replaces an invalid stored key syncs using the replacement bearer after success; a vault sync401 never causes republishing/minting. Preserve publish quota count.

For leakage tests, set fake.linked to suppress existing intentional `#r=` handoff, seed multiple random rings and API errors whose messages contain secret-like values, and check `JSON.stringify(result)` plus logs contains none of the rings, boxes, fixture VK, private DER or `account_vault.pub`. Separately assert existing ring-carrying browser links and private #p links still work, rather than pretending those intentional links contain no secrets. Existing tests expecting exact request ordering or `.at(-1)` publish bodies must select `/publish` by path now; do not weaken their payload assertions.
- [ ] **Step 2: Run RED.** `npm test -- test/server.test.ts -t 'vault|sync|trust'`. Each new test's name includes one of those terms; expected missing whoami lines/input and missing post-publish GET/PUT. Run the existing revoked-key tests separately to preserve that contract.
- [ ] **Step 3: Integrate with per-invocation notices.** Construct one `VaultSync({api,keys,log})` inside `createServer`. Keep the existing ring/link generation, then await sync **after** success and before returning; remove the early return that bypasses no-link publishes. Do not sync in `ensureName` or cached naming responses.

```ts
const FIRST_PIN = (f: string) => `First sync: pinned your account's vault ${f}. If /account shows a different fingerprint, tell me.`;
const SYNCED = (f: string) => `Private page keys: synced to your fmrl account (vault ${f}).`;
const NOT_SYNCED = "Private page keys: not synced (this key isn't in an account, or the account hasn't turned on sync).";
const CHANGED = (old: string, next: string) => `Your account's vault fingerprint changed from ${old} to ${next}, so I didn't send your key rings. If you reset private page sync on fmrl.site/account and it shows ${next}, ask me to trust it.`;
```

`publishAs` accepts a per-invocation `notices: string[]` in addition to its existing arguments. After making any link ring, call `vault.sync(k)` and append first-pin copy if present; do not append a synced/not-synced status on publish (screen10 specifies whoami). Pin mismatch need not add new publish output; next whoami reports approved changed copy. Each `publishOrSeal` invocation allocates its own notices array; render the existing public/private text followed by those notices. Do not store notices in a global map or mutate shared state across concurrent tool calls.

Whoami input becomes `{trust_vault: z.string().optional()}`; keep existing description without inventing a `.describe()` string. Whoami fetches fresh `me`, generates its ring using existing code, then calls `vault.sync(k,{me,trust:trust_vault})`. Destructure `const {account_vault: ignoredVault, ...publicMe} = me` before adding `link_url` and returning `publicMe`. Render synced/none/changed with the constants above; unknown adds no status. First pin, including an unknown outcome, adds the once-only approved pin line when a canonical fingerprint exists. No extra structured vault state is needed.
- [ ] **Step 4: Run GREEN.** `npm test -- test/server.test.ts test/vault-sync.test.ts && npm run typecheck`. Run full `npm test` once integration is stable and fix any newly stale request assertions by selecting the relevant route rather than dropping checks.
- [ ] **Step 5: Commit.** `git add packages/mcp/src/server.ts packages/mcp/test/server.test.ts && git commit -m "feat: sync vault rings on publish and whoami"`.

### Task 5: Skill guidance, release version and final PR gate

**Files:** Modify root README.md, packages/mcp/README.md, plugins/fmrl/skills/whoami/SKILL.md, packages/mcp/package.json, packages/mcp/package-lock.json, plugins/fmrl/.claude-plugin/plugin.json; test `packages/mcp/test/plugin-files.test.ts`.

**Interfaces:** Consumes deployed API-compatible local tool behavior; produces accurate skill relay rules and 0.15.0 manifests. No user copy is added to tool results. Technical docs explain behavior/limits; user-facing sync lines are quoted verbatim from screens10–11.

- [ ] **Step 1: Add the failing skill contract test.** In existing plugin-files tests, read whoami SKILL.md using its existing repo-root path pattern and assert it covers the new argument and retains explicit consent:

```ts
expect(whoamiSkill).toContain("trust_vault");
expect(whoamiSkill).toContain("explicitly");
expect(whoamiSkill).toContain("fingerprint");
expect(whoamiSkill).not.toContain("Signing in does not back up private-page keys.");
```

Use the existing test suite's manifest major.minor consistency check for version agreement; do not add an implementation-mirroring hardcoded version test.
- [ ] **Step 2: Run RED.** `npm test -- test/plugin-files.test.ts`. Expected obsolete skill account-backup sentence/missing trust guidance; confirm actual file contents cause RED.
- [ ] **Step 3: Edit docs and bump versions.** The skill relays supplied approved vault lines, checks the person explicitly confirmed the fingerprint shown on `/account`, and then calls `fmrl_whoami` once with that exact value as `trust_vault`. Never auto-trust a changed fingerprint, instruct the agent to obtain secrets, edit credentials/cache, or fabricate account status. Keep credential-file/FMRL_RING backup advice because history and unsynced/unclaimed rings are not fully recoverable. If the result is operational unknown, relay only supplied output and do not claim success.

README tool table documents optional `trust_vault`, TOFU per origin, every successful publish/whoami sync, ≤50 batches, shared default60/hour edit budget, silent403/409 and best-effort operational failures. Document environment ring scope (file rings only), historical last-writer limitation, no account required to share and no account IDs/private vault material in local tool output. Retain existing installation/client-specific auto-update behavior.

After checking current origin/main version, from packages/mcp:

```bash
npm version 0.15.0 --no-git-tag-version
```

Set `plugins/fmrl/.claude-plugin/plugin.json` version to `0.15.0`; do not change marketplace version unless an existing contract/test explicitly requires it. Release workflow is unchanged.
- [ ] **Step 4: Run full GREEN and cross-client checks.** With bundled Node on PATH, run `npm test`, `npm run typecheck`, `npm run build`, `git diff --check`. Keep full stdout/logs and report failing output if any. CI runs npm test/build on Node20/22. Do not use a private fixture token; byte comparison against the reviewed local Go fixture suffices for this fixture's provenance, and the existing renderer fixture workflow remains unchanged.

Generate a Node box with `npx tsx scripts/vault-fixture.ts`. Ask the controller to run a Go test-side `OpenRingBox` against that box in PR1's separate worktree, removing only its temporary verification file; do not work concurrently in PR1. Verify the fixture's original box opens in Node, the generated Node box opens in Go, and the fixture copy remains byte-identical. No production opener or private-key import may appear under `src`/built dist. Search changed logs for identifiers/error interpolation and tool-result spreads for unstripped `account_vault`.
- [ ] **Step 5: Commit and hand the PR gate to the controller.** Stage only these docs/version/test files and `git commit -m "feat: release account vault ring sync in fmrl 0.15"`. Controller re-fetches origin/main, checks `origin/main..HEAD` scope/base, checks current open PRs, and opens a **draft** plugin PR. Mark ready after full local/CI suite green and cross-client check; collect CodeRabbit review, push fixes in one batch and request `@coderabbitai review` once. Report PR URL/checks, declined findings with reasons, historical-ring spec amendment, and operational-unknown output decision. Stop at ready/green/reviewed; Marty owns merge/npm release.

## Planning baseline and execution notes

- `npm ci --no-audit --no-fund` succeeded with 152 packages using `/Users/martymulligan/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin` on PATH.
- `npm run build` passed TypeScript, asset copying and distribution smoke. Baseline log: `/private/tmp/fmrl-pr3-baseline-build.log`.
- `npm test` passed: **21 test files, 486 tests**, 1.84s, on the authorized escalated run. Log: `/private/tmp/fmrl-pr3-baseline-test-escalated.log`. The original sandboxed run could not bind the fake HTTP server (`node:http` localhost probe returned `EPERM`); it was stopped, not treated as product RED. Its partial/time-out output remains in `/private/tmp/fmrl-pr3-baseline-test.log` for provenance. No test process remains running.
- Read-only `gh pr list --repo toogreatwtf/fmrl-plugin --state open` returned no open PRs on 2026-10-06.
- This is a plan-only commit. No production code, fixture, version file or installed plugin is changed while writing it.
