# fmrl: Key Durability — Plugin (PR 3, fmrl-mcp 0.5.0) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The plugin keeps one random 256-bit key ring per API key beside the key in `credentials.json`, seals every private page's key and title under it as the `sealed` record on publish, appends `#r=<prefix>.<ring>` to every browser link it relays so the browser that redeems it can open those records, hands every page back with `fmrl_list` (a private page by name, with its keyed link), and tells the person in `fmrl_whoami` which file to back up — with fmrl.site still never seeing a ring or a content key.

**Architecture:** `crypto.ts` gains the sealed-record routine (`sealRecord`/`openRecord`, `newRing`, `isRing`), proven against a byte-for-byte copy of the server's Go-sealed fixture. `credentials.ts` carries `ring` on a stored key and a `rings` map (by key prefix) for env-supplied and replaced keys; `config.ts` reads `FMRL_RING`; `KeyStore` gains `ringFor(key)` (env, else stored, else mint-and-save, single-flighted) and `ringsFor(key)` (every ring that may open a record, never mints). `api.ts` sends `sealed` and gains `list()`; the fake API serves `GET /docs` and keeps `sealed` for its owner only. In `server.ts`, one `publishAs` seals inside `withKey` (so a 401 retry reseals under the replacement key's ring) and appends the ring to `link_url`; `fmrl_whoami` mints the ring and names the file; `fmrl_list` (new) and `fmrl_get` unseal with `ringsFor`. The skill, both READMEs, the version and `scripts/e2e.mjs` follow.

**Tech Stack:** TypeScript (ES2022, NodeNext), Node ≥ 20 WebCrypto (AES-256-GCM), `@modelcontextprotocol/sdk` McpServer with zod schemas, vitest, an in-process fake API (`test/fake-api.ts`).

**Spec:** markymd `docs/superpowers/specs/2026-09-18-fmrl-key-durability-design.md` — §1 (the ring), §2 (the record), §7 (the plugin), §8 (copy, with its dated 2026-09-20 amendments: only `fmrl_whoami` names the ring file), §9's Node bullet, §12 step 3. Read it with `git -C ~/projects/markymd show origin/main:docs/superpowers/specs/2026-09-18-fmrl-key-durability-design.md`. PR 1 (server, markymd #71) and PR 2 (browser, markymd #73) are merged; production serves PR 1 (`GET https://fmrl.site/api/v1/openapi.json` lists `/docs`, checked 2026-09-21).

**Facts from PRs 1–2 this plan relies on, where the spec says otherwise or nothing:**

- The API refuses a bad `sealed` with 400 `bad_request` (not the spec's `invalid`), and `sealed` only on `encrypted: true`. Its message: `sealed must be an unpadded base64url record of at most 1 KiB, and only on an encrypted page.`
- `GET /api/v1/docs` → `{"docs":[…]}`, newest first, 50 at most, removed and expired left out, quarantined included (`status: "quarantined"`). Each row is the `GET /api/v1/docs/{id}` shape: `id, url, status, format, size, rev, private, sealed?, expires_at, pinned, cid?, pinned_rev?` — **no `title`**. `GET /api/v1/docs/{id}` returns `sealed` only to the owning key.
- A key's display prefix is its first 9 characters (`apikey.PrefixLength`), e.g. `fmrl_ab12`. The browser accepts `#r=` as comma-separated `<prefix>.<ring>`, prefix `[A-Za-z0-9_]{1,16}`, ring `[A-Za-z0-9_-]{43}`, and stores a ring only for prefixes the link's confirm form names — the keys that link carries.
- PR 2 dropped the ring-file sentence from the browser drawer (§8 amended). `fmrl_whoami` is the **only** place that says "Your key ring is in {file}; back up that file to keep every page's key."

**Rulings against the spec's text (or where it is silent), decided here:**

1. **`fmrl_list`'s public rows carry no title.** §7 says "Public rows render title and url", but the API row has no `title` (only a revision record does, one request per page). A public row renders `url — expires …`. If wrong: an agent lists public pages by URL only; the fix is a `title` on the server's `docResponse`, not a request per row.
2. **A ring is minted whenever one must seal or travel**: a private publish, `fmrl_whoami`, and any publish whose answer carries `link_url`. §1 names only the first two, but §7 puts `#r=` on every `link_url`, and a browser linked through a first *public* publish would otherwise never receive the ring and every later private page would read *needs its key* there. If wrong: a 43-character secret on disk for a key that never publishes privately.
3. **A ring that cannot be saved never costs a publish.** The spec is silent. If `credentials.json` cannot be written, the page publishes without `sealed` (exactly as 0.4.0 did) and the link without `#r=`, with a line on stderr; `fmrl_whoami` says so in its ring line. An oversize record is different: it fails the publish before any request (Marty's instruction, as Go's `SealRecord` refuses it). If wrong: a read-only config directory loses durability quietly — but it is logged, and `fmrl_whoami` names it.
4. **`FMRL_RING` changes the whoami line** to "Your key ring comes from FMRL_RING; back up that value to keep every page's key.", since the file sentence would be false. If wrong: one line of copy.
5. **The skill**: "If the user asks for a page they shared earlier, call `fmrl_list`" goes in step 1, where the publish-or-not decision is made, not step 2 (the reply). "Never print the ring" is written so it cannot be read as "strip `#r=` from the link", which would silently break the feature. If wrong: two sentences of skill copy.
6. **Whoami's own link line** gains the same "It also carries the ring…" sentence as `LINK_HINT`; **`fmrl_get` on a private page** now says "a private page cannot be kept" rather than the public seven-days line, since `private` is known. If wrong: copy.
7. **§9's Node bullet** runs the plugin's `openRecord` "from `go test`" — impossible across repos. Instead: the plugin's vitest opens the byte-identical fixture; a `node:crypto` opener (not the plugin's own) proves the plugin seals Go's wire layout; and Task 7 has Go's `crypto.OpenRecord` open a plugin-sealed record once, by hand. §2 says the plugin's `scripts/fixture.ts` generates the mirror; per Marty, it is copied byte-for-byte and never regenerated.
8. **`scripts/e2e.mjs` refuses to run without an explicit `FMRL_API_URL`** (it used to default to production). If wrong: one env var to type for a deliberate production smoke.
9. **The local server for the e2e listens on 8097, not 8080**, so another session's Playwright (`reuseExistingServer: true` on 8080) can never pick it up and test the wrong binary. If wrong: nothing.

## Global Constraints

- **Nothing sends a ring or a content key to fmrl.site.** `sealed` is the only new field posted, and it is ciphertext. `#r=` and `#p=` live in the fragment only. A ring never appears in a log line, an error message (not even `FMRL_RING`'s), or a tool result except inside a browser link after `#r=`.
- **Sealed record wire form:** `base64url(nonce[12] || AES-256-GCM(ring, nonce, JSON {"k": key, "t": title}))`, unpadded base64url, no additional data, at most 1024 bytes decoded (refused over it, as Go's `SealRecord` does). `t` is cut to 200 code points without splitting a surrogate pair (`Array.from(title).slice(0, 200).join("")`).
- **Ring:** 32 random bytes as 43 base64url characters (`/^[A-Za-z0-9_-]{43}$/`). One per API key. `#r=` pair: `<prefix>.<ring>` where prefix is the key's first 9 characters.
- **Fixture:** `packages/mcp/test/fixtures/sealed.json` is a byte-for-byte copy of markymd `origin/main:internal/crypto/testdata/sealed.json` (`git -C ~/projects/markymd show origin/main:internal/crypto/testdata/sealed.json > packages/mcp/test/fixtures/sealed.json`). Never regenerate or reformat it.
- **`credentials.json` stays `version: 1`**; `ring` on a stored key and the top-level `rings` map are additive. Writes stay atomic, 0600, dir 0700 (`writeCredentials`). A ring is written to the file *before* anything is sealed under it. A replaced key's ring is never dropped.
- **Copy, verbatim:**
  - `LINK_HINT(url)`: `See your pages on fmrl.site: open ${url} once in your browser (it works for an hour, and once). It also carries the ring that lets that browser open your private pages.`
  - whoami link line: `To see this key's pages on fmrl.site, open ${url} (works for an hour, and once). It also carries the ring that lets that browser open your private pages.`
  - `RING_FILE_LINE(file)`: `Your key ring is in ${file}; back up that file to keep every page's key.`
  - `RING_ENV_LINE`: `Your key ring comes from FMRL_RING; back up that value to keep every page's key.`
  - `RING_UNSAVED_LINE(file, why)`: `Couldn't save a key ring to ${file} (${why}); private pages publish without their key sealed until it can be written, or FMRL_RING is set.`
  - `NOT_HELD_LINE`: `This page is private and its key is not held here: it opens from its link, or from a browser linked to the key that published it.`
  - `LIST_EMPTY`: `This key has no pages right now; removed and expired pages are not listed.`
  - list rows: `- ${title || "untitled private page"} — ${url}#p=${key} — ${when}`, `- private page (key not held here) — ${url} — ${when}`, `- ${url} — ${when}`; `when` is `kept` or `expires ${expires_at}`, plus `, ${status}` unless the status is `live` or `pinned`.
- No new dependencies. Node ≥ 20 (CI runs 20 and 22). Match the existing style: one-line JSDoc on exports, `node:` imports, `.js` import suffixes.
- **Checks after every task** (from `packages/mcp`): `npm test` and `npm run typecheck`. Before the PR: `npm ci && npm test && npm run typecheck && npm run build` — CI's `test` workflow runs `npm ci`, `npm test`, `npm run build` on Node 20 and 22.
- **Never** touch `~/.claude/plugins/marketplaces/fmrl-plugin` or `~/.claude/plugins/cache/fmrl-plugin`. **Never** run `scripts/e2e.mjs` against production, and never without asking Marty first. **Never** `npm publish`. Do not bump `plugins/fmrl/.claude-plugin/plugin.json` (the manifest PR follows the publish and is Marty's).
- Work only in `~/projects/fmrl-plugin-key-durability` on branch `claude/key-durability-plugin`. markymd is read-only context (`git -C ~/projects/markymd show origin/main:<path>`).
- Commits: `mcp: …` subjects, ending with the line `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`. In a worktree-isolated session, split compound bash that mixes in git into plain commands.

## File Structure

- `packages/mcp/src/crypto.ts` — `MAX_SEALED_RECORD`, `OpenedRecord`, `isRing`, `newRing`, `sealRecord`, `openRecord` (Task 1).
- `packages/mcp/test/sealed.test.ts` (new), `packages/mcp/test/fixtures/sealed.json` (new, copied) — Task 1.
- `.coderabbit.yaml` — the fixtures comment names the copy (Task 1).
- `packages/mcp/src/credentials.ts` — `StoredKey.ring`, `CredentialsFile.rings`, `readCredentials` keeps and sanitizes them (Task 2).
- `packages/mcp/src/config.ts` — `Config.ring` from `FMRL_RING` (Task 2).
- `packages/mcp/src/keys.ts` — `PREFIX_LENGTH`, `prefixOf`, `KeyStoreOptions.ringFromEnv`, `KeyStore.file`, `.ringFromEnv`, `.ringFor`, `.ringsFor`; `mint` moves a replaced key's ring (Task 2).
- `packages/mcp/src/index.ts` — passes `ringFromEnv` and `log` (Tasks 2, 4).
- `packages/mcp/src/api.ts` — `PublishRequest.sealed`, `DocResponse` fields, `DocsResponse`, `list()` (Task 3).
- `packages/mcp/test/fake-api.ts` — `GET /docs`, `sealed` kept and validated, owner-only on read (Task 3).
- `packages/mcp/src/markdown.ts` — `documentTitle` (Task 4).
- `packages/mcp/src/server.ts` — `ServerDeps.log`, `withRing`, ring copy, `publishAs`, `preparePrivate`'s title, whoami (Task 4); `unseal`, `PageRow`, `pageRow`, `docText`, `listText`, `fmrl_list`, `fmrl_get` (Task 5).
- Tests: `credentials.test.ts`, `config.test.ts`, `keys.test.ts` (Task 2); `api.test.ts` (Task 3); `markdown.test.ts`, `server.test.ts` (Tasks 4, 5).
- `plugins/fmrl/skills/share/SKILL.md`, `README.md`, `packages/mcp/README.md`, `packages/mcp/package.json` + `package-lock.json` (0.5.0), `packages/mcp/scripts/e2e.mjs` — Task 6.

---

### Task 0: Ignore `.superpowers/` and commit this plan

**Files:**
- Modify: `.gitignore`
- Create: `docs/superpowers/plans/2026-09-21-fmrl-key-durability-plugin.md` (this file)

- [ ] **Step 1: Add `.superpowers/` to `.gitignore`** (before any SDD ledger exists), so it reads:

```
node_modules/
dist/
*.tgz
.DS_Store
.superpowers/
```

- [ ] **Step 2: Commit**

```bash
git add .gitignore docs/superpowers/plans/2026-09-21-fmrl-key-durability-plugin.md
git commit -m "docs: key durability PR 3 plan; ignore .superpowers/

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 1: The sealed record, proven against the Go fixture

**Files:**
- Modify: `packages/mcp/src/crypto.ts` (append after `openEnvelope`)
- Create: `packages/mcp/test/fixtures/sealed.json` (copied)
- Create: `packages/mcp/test/sealed.test.ts`
- Modify: `.coderabbit.yaml` (the fixtures comment)

**Interfaces:**
- Consumes: `b64url`, `unb64url`, `subtle` already in `crypto.ts`.
- Produces:
  ```ts
  export const MAX_SEALED_RECORD = 1024;
  export interface OpenedRecord { key: string; title: string }
  export function isRing(s: unknown): s is string;
  export function newRing(): string;
  export async function sealRecord(ring: string, key: string, title: string): Promise<string>;
  export async function openRecord(ring: string, sealed: string): Promise<OpenedRecord>; // rejects on anything but a record under ring
  ```

- [ ] **Step 1: Copy the fixture byte-for-byte and check it**

```bash
git -C ~/projects/markymd fetch origin main
git -C ~/projects/markymd show origin/main:internal/crypto/testdata/sealed.json > packages/mcp/test/fixtures/sealed.json
git -C ~/projects/markymd show origin/main:internal/crypto/testdata/sealed.json | sha256sum
sha256sum packages/mcp/test/fixtures/sealed.json
```

Expected: the two hashes are identical. Do not open the file in an editor that reformats JSON.

- [ ] **Step 2: Write the failing test** — `packages/mcp/test/sealed.test.ts`:

```ts
import { createDecipheriv } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { MAX_SEALED_RECORD, isRing, newRing, openRecord, sealRecord } from "../src/crypto.js";

// fixtures/sealed.json is a byte-for-byte copy of markymd's
// internal/crypto/testdata/sealed.json, sealed by Go. The browser's fmrl.js
// opens the same file under Node from markymd's go test, and this opens it
// with the plugin's code. Never regenerate it here: the point is three
// sealers opening one file.
const fixture = async () => JSON.parse(await readFile(new URL("./fixtures/sealed.json", import.meta.url), "utf8")) as {
  ring: string; record: { k: string; t: string }; sealed: string;
};

describe("sealed records", () => {
  it("opens the Go-sealed fixture under its ring", async () => {
    const fx = await fixture();
    expect(await openRecord(fx.ring, fx.sealed)).toEqual({ key: fx.record.k, title: fx.record.t });
  });
  it("refuses the fixture under another ring", async () => {
    const fx = await fixture();
    await expect(openRecord(newRing(), fx.sealed)).rejects.toThrow();
  });
  it("refuses every wrong shape by rejecting", async () => {
    const fx = await fixture();
    // Empty, not base64url, padded, too short for a nonce and a tag, over 1 KiB decoded.
    for (const bad of ["", "not base64url!", fx.sealed + "=", "AAAA", "A".repeat(1400)]) {
      await expect(openRecord(fx.ring, bad)).rejects.toThrow();
    }
    await expect(openRecord("short", fx.sealed)).rejects.toThrow();
  });
  it("seal then open round-trips the key and the title", async () => {
    const fx = await fixture();
    const title = "Tom & Jerry — “quotes” 🙂";
    const sealed = await sealRecord(fx.ring, fx.record.k, title);
    expect(sealed).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(await openRecord(fx.ring, sealed)).toEqual({ key: fx.record.k, title });
  });
  it("seals the layout Go opens: nonce, ciphertext, tag, unpadded base64url, no additional data", async () => {
    // Opened with node:crypto rather than the plugin's own openRecord, the
    // way internal/crypto.OpenRecord reads it: raw[:12] is the nonce, the
    // last 16 bytes are the tag.
    const fx = await fixture();
    const raw = Buffer.from(await sealRecord(fx.ring, fx.record.k, fx.record.t), "base64url");
    const d = createDecipheriv("aes-256-gcm", Buffer.from(fx.ring, "base64url"), raw.subarray(0, 12));
    d.setAuthTag(raw.subarray(raw.length - 16));
    const plain = Buffer.concat([d.update(raw.subarray(12, raw.length - 16)), d.final()]).toString("utf8");
    expect(JSON.parse(plain)).toEqual(fx.record);
  });
  it("cuts a long title to 200 code points without splitting a surrogate pair", async () => {
    const ring = newRing();
    const opened = await openRecord(ring, await sealRecord(ring, "A".repeat(43), "🙂".repeat(300)));
    expect(opened.title).toBe("🙂".repeat(200));
  });
  it("refuses a record over 1024 bytes decoded, as Go's SealRecord does", async () => {
    // 200 control characters JSON-escape to six bytes apiece.
    await expect(sealRecord(newRing(), "A".repeat(43), "\u0001".repeat(200))).rejects.toThrow(`over the ${MAX_SEALED_RECORD}-byte limit`);
  });
  it("mints rings of the ring's shape, each one different", () => {
    const a = newRing();
    expect(isRing(a)).toBe(true);
    expect(Buffer.from(a, "base64url")).toHaveLength(32);
    expect(newRing()).not.toBe(a);
    expect(isRing("A".repeat(42))).toBe(false);
    expect(isRing("A".repeat(42) + "=")).toBe(false);
    expect(isRing(undefined)).toBe(false);
  });
});
```

- [ ] **Step 3: Run it to see it fail**

Run: `cd packages/mcp && npx vitest run test/sealed.test.ts`
Expected: FAIL — `sealRecord` / `openRecord` / `newRing` / `isRing` / `MAX_SEALED_RECORD` are not exported.

- [ ] **Step 4: Implement** — append to `packages/mcp/src/crypto.ts`:

```ts
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
const PAGE_KEY_SHAPE = /^[A-Za-z0-9_-]{43}$/;

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
```

- [ ] **Step 5: Run the test and the suite**

Run: `cd packages/mcp && npx vitest run test/sealed.test.ts && npm test && npm run typecheck`
Expected: PASS (8 new tests; 80 total), typecheck clean.

- [ ] **Step 6: Name the copy in `.coderabbit.yaml`** — replace the fixtures comment's parenthesis so it reads:

```yaml
  # Exclude what a reviewer cannot act on: lockfiles, compiled output if
  # it is ever committed, and the crypto interop fixtures (generated by
  # packages/mcp/scripts/fixture.ts, or copied byte-for-byte from
  # markymd's internal/crypto/testdata — never written by hand).
```

- [ ] **Step 7: Commit**

```bash
git add packages/mcp/src/crypto.ts packages/mcp/test/sealed.test.ts packages/mcp/test/fixtures/sealed.json .coderabbit.yaml
git commit -m "mcp: sealed records — sealRecord/openRecord and rings, proven against the Go fixture

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: The ring in credentials.json, FMRL_RING, and the key store

**Files:**
- Modify: `packages/mcp/src/credentials.ts`
- Modify: `packages/mcp/src/config.ts`
- Modify: `packages/mcp/src/keys.ts`
- Modify: `packages/mcp/src/index.ts`
- Test: `packages/mcp/test/credentials.test.ts`, `packages/mcp/test/config.test.ts`, `packages/mcp/test/keys.test.ts`

**Interfaces:**
- Consumes: `isRing(s)`, `newRing()` from Task 1.
- Produces:
  ```ts
  // credentials.ts
  export interface StoredKey { key: string; prefix: string; created_at: string; ring?: string }
  export interface CredentialsFile { version: 1; keys: Record<string, StoredKey>; rings?: Record<string, string> }
  // config.ts
  export interface Config { baseUrl: string; apiKey?: string; ring?: string }
  // keys.ts
  export const PREFIX_LENGTH = 9;
  export function prefixOf(key: string): string;
  export interface KeyStoreOptions { api; baseUrl; file; apiKeyFromEnv?; ringFromEnv?: string; log? }
  class KeyStore {
    get file(): string;
    get ringFromEnv(): boolean;
    ringFor(key: string): Promise<string>;     // FMRL_RING, else stored, else minted and saved first; throws if the file can't be written
    ringsFor(key: string): Promise<string[]>;  // [FMRL_RING, key's own, ...rings values], deduped; never mints
  }
  ```

- [ ] **Step 1: Write the failing tests**

Append to `describe("read and write", …)` in `packages/mcp/test/credentials.test.ts`:

```ts
  it("keeps a key's ring and the rings map, and drops a malformed entry from the map", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "fmrl-"));
    const file = path.join(dir, "credentials.json");
    const data = {
      version: 1 as const,
      keys: { "https://fmrl.site": { key: "fmrl_x", prefix: "fmrl_x", created_at: "2026-09-08T00:00:00Z", ring: "R".repeat(43) } },
      rings: { fmrl_old1: "O".repeat(43) },
    };
    await writeCredentials(file, data);
    expect(await readCredentials(file)).toEqual(data);
    await writeFile(file, JSON.stringify({ ...data, rings: { fmrl_bad1: "short", fmrl_bad2: 7, fmrl_ok11: "K".repeat(43) } }));
    expect((await readCredentials(file)).rings).toEqual({ fmrl_ok11: "K".repeat(43) });
    for (const rings of ["nope", null]) {
      await writeFile(file, JSON.stringify({ version: 1, keys: {}, rings }));
      expect(await readCredentials(file)).toEqual({ version: 1, keys: {} });
    }
  });
```

Append to `describe("loadConfig", …)` in `packages/mcp/test/config.test.ts`:

```ts
  it("passes FMRL_RING through and treats an empty one as absent", () => {
    const ring = "r".repeat(43);
    expect(loadConfig({ FMRL_RING: ` ${ring} ` }).ring).toBe(ring);
    expect(loadConfig({ FMRL_RING: " " }).ring).toBeUndefined();
  });
  it("refuses a malformed FMRL_RING without echoing it", () => {
    const secret = "s3cret-but-not-a-ring";
    expect(() => loadConfig({ FMRL_RING: secret })).toThrow("FMRL_RING must be a key ring, 43 base64url characters; got 21 characters.");
    let message = "";
    try { loadConfig({ FMRL_RING: secret }); } catch (e) { message = (e as Error).message; }
    expect(message).not.toContain(secret);
  });
```

Append to `packages/mcp/test/keys.test.ts` (it already imports `readCredentials`, `writeCredentials`, `KeyStore`; `logs` is reset in `beforeEach`):

```ts
describe("KeyStore rings", () => {
  const RING = /^[A-Za-z0-9_-]{43}$/;
  it("mints a ring once, keeps it on the stored key, and logs the prefix but never the ring", async () => {
    const store = new KeyStore({ api, baseUrl: fake.baseUrl, file, log: (s) => logs.push(s) });
    const key = await store.getKey();
    const ring = await store.ringFor(key);
    expect(ring).toMatch(RING);
    expect((await readCredentials(file)).keys[fake.baseUrl].ring).toBe(ring);
    expect(await store.ringFor(key)).toBe(ring);
    expect(await new KeyStore({ api, baseUrl: fake.baseUrl, file }).ringFor(key)).toBe(ring);
    expect(logs.join("\n")).toContain(`minted a key ring for ${key.slice(0, 9)}…`);
    expect(logs.join("\n")).not.toContain(ring);
  });
  it("shares one mint between concurrent calls", async () => {
    const store = new KeyStore({ api, baseUrl: fake.baseUrl, file });
    const key = await store.getKey();
    const rings = await Promise.all([store.ringFor(key), store.ringFor(key), store.ringFor(key)]);
    expect(new Set(rings).size).toBe(1);
    expect((await readCredentials(file)).keys[fake.baseUrl].ring).toBe(rings[0]);
  });
  it("prefers FMRL_RING and never writes it", async () => {
    const envRing = "E".repeat(43);
    const store = new KeyStore({ api, baseUrl: fake.baseUrl, file, ringFromEnv: envRing });
    expect(store.ringFromEnv).toBe(true);
    const key = await store.getKey();
    expect(await store.ringFor(key)).toBe(envRing);
    const saved = await readCredentials(file);
    expect(saved.keys[fake.baseUrl].ring).toBeUndefined();
    expect(saved.rings).toBeUndefined();
    expect(await store.ringsFor(key)).toEqual([envRing]);
  });
  it("keeps an environment key's ring under rings[prefix]", async () => {
    const envKey = "fmrl_" + "E".repeat(32);
    const store = new KeyStore({ api, baseUrl: fake.baseUrl, file, apiKeyFromEnv: envKey });
    const ring = await store.ringFor(envKey);
    const saved = await readCredentials(file);
    expect(saved.keys).toEqual({});
    expect(saved.rings).toEqual({ fmrl_EEEE: ring });
    expect(await new KeyStore({ api, baseUrl: fake.baseUrl, file, apiKeyFromEnv: envKey }).ringFor(envKey)).toBe(ring);
  });
  it("an environment key that is also the stored key seals under the stored key's ring", async () => {
    const stored = await new KeyStore({ api, baseUrl: fake.baseUrl, file }).getKey();
    const ring = await new KeyStore({ api, baseUrl: fake.baseUrl, file }).ringFor(stored);
    expect(await new KeyStore({ api, baseUrl: fake.baseUrl, file, apiKeyFromEnv: stored }).ringFor(stored)).toBe(ring);
  });
  it("moves a replaced key's ring to rings[oldPrefix] and mints the new key its own", async () => {
    const oldRing = "O".repeat(43);
    await writeCredentials(file, { version: 1, keys: { [fake.baseUrl]: { key: "fmrl_" + "S".repeat(32), prefix: "fmrl_SSSS", created_at: "x", ring: oldRing } } });
    const store = new KeyStore({ api, baseUrl: fake.baseUrl, file });
    const fresh = await store.withKey(async (k) => { await api.me(k); return k; });
    const saved = await readCredentials(file);
    expect(saved.rings).toEqual({ fmrl_SSSS: oldRing });
    expect(saved.keys[fake.baseUrl].ring).toBeUndefined();
    const ring = await store.ringFor(fresh);
    expect(ring).not.toBe(oldRing);
    expect(await store.ringsFor(fresh)).toEqual([ring, oldRing]);
  });
  it("ringsFor never mints", async () => {
    const store = new KeyStore({ api, baseUrl: fake.baseUrl, file });
    const key = await store.getKey();
    expect(await store.ringsFor(key)).toEqual([]);
    expect((await readCredentials(file)).keys[fake.baseUrl].ring).toBeUndefined();
  });
  it("replaces a malformed stored ring rather than sealing under it", async () => {
    const store = new KeyStore({ api, baseUrl: fake.baseUrl, file });
    const key = await store.getKey();
    const saved = await readCredentials(file);
    saved.keys[fake.baseUrl].ring = "not-a-ring";
    await writeCredentials(file, saved);
    const ring = await store.ringFor(key);
    expect(ring).toMatch(RING);
    expect((await readCredentials(file)).keys[fake.baseUrl].ring).toBe(ring);
  });
  it("names its file", () => {
    expect(new KeyStore({ api, baseUrl: fake.baseUrl, file }).file).toBe(file);
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `cd packages/mcp && npx vitest run test/credentials.test.ts test/config.test.ts test/keys.test.ts`
Expected: FAIL — `rings` is dropped on read, `ring` is undefined on the config, `ringFor`/`ringsFor`/`file`/`ringFromEnv` do not exist.

- [ ] **Step 3: Implement `credentials.ts`**

Add `import { isRing } from "./crypto.js";` and replace the two interfaces and `readCredentials`:

```ts
export interface StoredKey {
  key: string;
  prefix: string;
  created_at: string;
  /** ring seals this key's private pages' records. Minted the first time one is needed; it leaves this machine only inside a browser link's fragment. */
  ring?: string;
}

export interface CredentialsFile {
  version: 1;
  keys: Record<string, StoredKey>;
  /**
   * rings holds, by key prefix, the rings of keys that are not the stored
   * key for their base URL: a key from FMRL_API_KEY, and a key replaced
   * after a 401, whose pages still exist and whose records open only under it.
   */
  rings?: Record<string, string>;
}
```

```ts
/** readCredentials treats a missing, unreadable, or malformed file as empty, and drops a malformed entry from rings. */
export async function readCredentials(file: string): Promise<CredentialsFile> {
  try {
    const parsed = JSON.parse(await readFile(file, "utf8")) as Partial<CredentialsFile>;
    if (parsed && parsed.version === 1 && parsed.keys && typeof parsed.keys === "object") {
      const out: CredentialsFile = { version: 1, keys: { ...parsed.keys } };
      const rings = Object.entries(parsed.rings && typeof parsed.rings === "object" ? parsed.rings : {}).filter(([, r]) => isRing(r));
      if (rings.length > 0) out.rings = Object.fromEntries(rings);
      return out;
    }
    return { ...EMPTY, keys: {} };
  } catch {
    return { ...EMPTY, keys: {} };
  }
}
```

- [ ] **Step 4: Implement `config.ts`**

```ts
import { isRing } from "./crypto.js";

export interface Config {
  baseUrl: string;
  apiKey?: string;
  /** ring is FMRL_RING: the key ring to seal under instead of the stored one. */
  ring?: string;
}
```

In `loadConfig`, before the `return`, and extend the return:

```ts
  const rawRing = (env.FMRL_RING ?? "").trim();
  // A ring is a secret: the message names its length, never its value.
  if (rawRing !== "" && !isRing(rawRing)) {
    throw new Error(`FMRL_RING must be a key ring, 43 base64url characters; got ${rawRing.length} characters.`);
  }
  return { baseUrl, apiKey: rawKey === "" ? undefined : rawKey, ring: rawRing === "" ? undefined : rawRing };
```

Update the doc comment: `/** loadConfig reads FMRL_API_URL, FMRL_API_KEY and FMRL_RING; the client appends /api/v1 to baseUrl. */`

- [ ] **Step 5: Implement `keys.ts`**

Imports become:

```ts
import { ApiError, type FmrlApi } from "./api.js";
import { readCredentials, writeCredentials, type CredentialsFile } from "./credentials.js";
import { isRing, newRing } from "./crypto.js";
```

`KeyStoreOptions` gains, after `apiKeyFromEnv`:

```ts
  /** ringFromEnv is FMRL_RING: every private page's record is sealed under it, and it is never written to the file. */
  ringFromEnv?: string;
```

After `const LABEL = "fmrl-mcp";` add:

```ts
/** PREFIX_LENGTH is the server's apikey.PrefixLength. A key's prefix is what the link page names, and what a #r= pair pairs a ring with. */
export const PREFIX_LENGTH = 9;

/** prefixOf is a key's display prefix: fmrl_ and four characters. */
export function prefixOf(key: string): string {
  return key.slice(0, PREFIX_LENGTH);
}

/** storedRing is the ring the file keeps for key: its base URL's entry when that entry is key, else rings[prefix]. */
function storedRing(file: CredentialsFile, baseUrl: string, key: string): string | undefined {
  const entry = file.keys[baseUrl];
  if (entry?.key === key && isRing(entry.ring)) return entry.ring;
  const ring = file.rings?.[prefixOf(key)];
  return isRing(ring) ? ring : undefined;
}
```

Extend the class doc comment with one sentence: `Each key also has a ring, the secret its private pages' keys are sealed under (ringFor).` Inside the class, add a field beside `pending`:

```ts
  private readonly ringPending = new Map<string, Promise<string>>();
```

and, after the constructor:

```ts
  /** file is where the key and its ring live. */
  get file(): string {
    return this.o.file;
  }

  /** ringFromEnv reports whether FMRL_RING supplies the ring. */
  get ringFromEnv(): boolean {
    return this.o.ringFromEnv !== undefined;
  }
```

After `withKey`, add:

```ts
  /**
   * ringFor is the ring key's private pages are sealed under: FMRL_RING when
   * set, else the one the file keeps for key, else a fresh one — written to
   * the file before it is returned, so nothing is ever sealed under a ring
   * the file does not hold. Concurrent calls for one key share one mint.
   * Throws when the file cannot be written.
   */
  ringFor(key: string): Promise<string> {
    if (this.o.ringFromEnv) return Promise.resolve(this.o.ringFromEnv);
    let p = this.ringPending.get(key);
    if (!p) {
      p = this.loadOrMintRing(key).finally(() => this.ringPending.delete(key));
      this.ringPending.set(key, p);
    }
    return p;
  }

  /** ringsFor lists every ring that may open a record on key's pages, the one ringFor would seal under first. It never mints. */
  async ringsFor(key: string): Promise<string[]> {
    const file = await readCredentials(this.o.file);
    const all = [this.o.ringFromEnv, storedRing(file, this.o.baseUrl, key), ...Object.values(file.rings ?? {})];
    return [...new Set(all.filter(isRing))];
  }

  private async loadOrMintRing(key: string): Promise<string> {
    const file = await readCredentials(this.o.file);
    const found = storedRing(file, this.o.baseUrl, key);
    if (found) return found;
    const ring = newRing();
    const entry = file.keys[this.o.baseUrl];
    if (entry?.key === key) entry.ring = ring;
    else file.rings = { ...file.rings, [prefixOf(key)]: ring };
    await writeCredentials(this.o.file, file);
    this.o.log?.(`fmrl-mcp: minted a key ring for ${prefixOf(key)}…, saved to ${this.o.file}`);
    return ring;
  }
```

In `mint()`, between `const file = await readCredentials(this.o.file);` and `file.keys[this.o.baseUrl] = …`, add:

```ts
    // A replaced key's ring stays, under its prefix: its pages still exist,
    // and their sealed records open only under it.
    const old = file.keys[this.o.baseUrl];
    if (old && isRing(old.ring)) file.rings = { ...file.rings, [old.prefix || prefixOf(old.key)]: old.ring };
```

- [ ] **Step 6: Pass FMRL_RING through `index.ts`**

```ts
  const keys = new KeyStore({ api, baseUrl: cfg.baseUrl, apiKeyFromEnv: cfg.apiKey, ringFromEnv: cfg.ring, file: credentialsPath(), log });
```

- [ ] **Step 7: Run the tests and the suite**

Run: `cd packages/mcp && npx vitest run test/credentials.test.ts test/config.test.ts test/keys.test.ts && npm test && npm run typecheck`
Expected: PASS (12 new tests; 92 total), typecheck clean.

- [ ] **Step 8: Commit**

```bash
git add packages/mcp/src/credentials.ts packages/mcp/src/config.ts packages/mcp/src/keys.ts packages/mcp/src/index.ts packages/mcp/test/credentials.test.ts packages/mcp/test/config.test.ts packages/mcp/test/keys.test.ts
git commit -m "mcp: a key ring beside each key — stored, FMRL_RING, rings for env and replaced keys

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: `sealed` on publish and `GET /docs`, in the client and the fake

**Files:**
- Modify: `packages/mcp/src/api.ts`
- Modify: `packages/mcp/test/fake-api.ts`
- Test: `packages/mcp/test/api.test.ts`

**Interfaces:**
- Consumes: `sealRecord`, `newRing` (Task 1) in tests.
- Produces:
  ```ts
  export interface PublishRequest { content: string; format?: "html" | "md"; title?: string; encrypted?: boolean; sealed?: string }
  export interface DocResponse { id; url; status; format; size; expires_at: string | null; pinned; cid?; rev?: number; private?: boolean; sealed?: string }
  export interface DocsResponse { docs: DocResponse[] }
  FmrlApi.list(key: string): Promise<DocsResponse>   // GET /api/v1/docs
  // fake-api.ts
  export interface FakeDoc { id; owner; format; size; title?; removed?; encrypted?: boolean; sealed?: string; status?: string }
  ```

- [ ] **Step 1: Write the failing tests** — add to `packages/mcp/test/api.test.ts` (import `newRing, sealRecord` from `../src/crypto.js`):

```ts
  it("sends sealed on a private publish, and lists this key's pages newest first", async () => {
    const { key } = await api.mint("x");
    const sealed = await sealRecord(newRing(), "A".repeat(43), "Quiet");
    const a = await api.publish(key, { content: "# public" });
    const b = await api.publish(key, { content: "MARKYENC{}", format: "html", encrypted: true, sealed });
    expect(fake.requests.at(-1)?.body).toMatchObject({ encrypted: true, sealed });
    const stranger = await api.mint("y");
    await api.publish(stranger.key, { content: "# not mine" });
    const { docs } = await api.list(key);
    expect(fake.requests.at(-1)).toMatchObject({ method: "GET", path: "/api/v1/docs", auth: `Bearer ${key}` });
    expect(docs.map((d) => d.id)).toEqual([b.id, a.id]);
    expect(docs[0]).toMatchObject({ private: true, sealed, rev: 1 });
    expect(docs[1]).toMatchObject({ private: false });
    expect(docs[1]).not.toHaveProperty("sealed");
  });
  it("hands a page's sealed record to its owner only", async () => {
    const owner = await api.mint("x");
    const stranger = await api.mint("y");
    const sealed = await sealRecord(newRing(), "A".repeat(43), "t");
    const p = await api.publish(owner.key, { content: "MARKYENC{}", format: "html", encrypted: true, sealed });
    expect(await api.get(owner.key, p.id)).toMatchObject({ private: true, sealed });
    expect(await api.get(stranger.key, p.id)).not.toHaveProperty("sealed");
  });
  it("the fake refuses sealed on a public page and a malformed record, with the server's 400", async () => {
    const { key } = await api.mint("x");
    const sealed = await sealRecord(newRing(), "A".repeat(43), "t");
    await expect(api.publish(key, { content: "# public", sealed })).rejects.toMatchObject({ status: 400, code: "bad_request" });
    await expect(api.publish(key, { content: "MARKYENC{}", encrypted: true, sealed: "not a record" })).rejects.toMatchObject({ status: 400, code: "bad_request" });
  });
  it("sends no sealed field when none is given", async () => {
    const { key } = await api.mint("x");
    await api.publish(key, { content: "MARKYENC{}", encrypted: true });
    expect(fake.requests.at(-1)?.body as Record<string, unknown>).not.toHaveProperty("sealed");
  });
```

- [ ] **Step 2: Run them to see them fail**

Run: `cd packages/mcp && npx vitest run test/api.test.ts`
Expected: FAIL — `api.list` is not a function; `sealed` is not sent; the fake has no `/docs`.

- [ ] **Step 3: Implement `api.ts`**

Replace `PublishRequest` and `DocResponse`, add `DocsResponse`:

```ts
/** sealed is the page's key and title under the key's ring (crypto.sealRecord); the server takes it on an encrypted page only. */
export interface PublishRequest { content: string; format?: "html" | "md"; title?: string; encrypted?: boolean; sealed?: string }
```

```ts
/**
 * DocResponse is a page as GET /api/v1/docs/{id} and each GET /api/v1/docs row
 * describe it. rev and private come from servers with sealed records
 * (markymd #71); sealed is present only on a private page that has one, and
 * only to the key that owns the page.
 */
export interface DocResponse {
  id: string; url: string; status: string; format: string; size: number; expires_at: string | null; pinned: boolean; cid?: string;
  rev?: number; private?: boolean; sealed?: string;
}
/** DocsResponse is GET /api/v1/docs: this key's pages, newest first, 50 at most, removed and expired left out. */
export interface DocsResponse { docs: DocResponse[] }
```

In `publish`, after the `encrypted` line:

```ts
    if (body.sealed !== undefined) payload.sealed = body.sealed;
```

After `get`:

```ts
  list(key: string): Promise<DocsResponse> {
    return this.call<DocsResponse>("GET", "/docs", key);
  }
```

- [ ] **Step 4: Implement the fake** — in `packages/mcp/test/fake-api.ts`:

`FakeDoc` becomes:

```ts
export interface FakeDoc { id: string; owner: string; format: string; size: number; title?: string; removed?: boolean; encrypted?: boolean; sealed?: string; status?: string }
```

Add after `fail`:

```ts
// The server's rule for sealed: crypto.ValidateSealed's shape, on an encrypted page only.
function validSealed(s: unknown): boolean {
  if (typeof s !== "string" || !/^[A-Za-z0-9_-]+$/.test(s)) return false;
  const n = Buffer.from(s, "base64url").length;
  return n >= 30 && n <= 1024;
}

// docRow is the server's docResponseFor: sealed only to the owning key.
function docRow(d: FakeDoc, caller: string): Record<string, unknown> {
  const pinned = d.title === "PINNED";
  return {
    id: d.id, url: `https://fmrl.test/${d.id}`, status: d.status ?? "live", format: d.format, size: d.size, rev: 1,
    private: d.encrypted === true,
    ...(d.sealed && d.owner === caller ? { sealed: d.sealed } : {}),
    expires_at: pinned ? null : "2026-09-15T12:00:00Z",
    pinned,
    ...(pinned ? { cid: "bafytest" } : {}),
  };
}
```

In the publish branch, widen the body type to `{ format?: string; content?: string; title?: string; encrypted?: boolean; sealed?: unknown }`, add after the `encrypted && format === "md"` check:

```ts
      if (b.sealed !== undefined && (b.encrypted !== true || !validSealed(b.sealed))) return fail(res, 400, "bad_request", "sealed must be an unpadded base64url record of at most 1 KiB, and only on an encrypted page.");
```

and store the new fields:

```ts
      api.docs.set(id, { id, owner: key, format, size: Buffer.byteLength(b.content), title: b.title, encrypted: b.encrypted === true, sealed: typeof b.sealed === "string" ? b.sealed : undefined });
```

Before `const m = url.pathname.match(…)`, add:

```ts
    if (method === "GET" && url.pathname === "/api/v1/docs") {
      const key = auth();
      if (!key) return unauthorized();
      const docs = [...api.docs.values()].filter((d) => d.owner === key && !d.removed).reverse().slice(0, 50).map((d) => docRow(d, key));
      return json(res, 200, { docs });
    }
```

and replace the single-doc GET's inline object with `return json(res, 200, docRow(d, key));` (delete the now-unused local `pinned`).

- [ ] **Step 5: Run the tests and the suite**

Run: `cd packages/mcp && npx vitest run test/api.test.ts && npm test && npm run typecheck`
Expected: PASS (4 new tests; 96 total), typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add packages/mcp/src/api.ts packages/mcp/test/fake-api.ts packages/mcp/test/api.test.ts
git commit -m "mcp: sealed on publish and GET /docs in the client; the fake keeps sealed for its owner

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: Publish seals the key; every browser link carries the ring; whoami names the file

**Files:**
- Modify: `packages/mcp/src/markdown.ts` (add `documentTitle`)
- Modify: `packages/mcp/src/server.ts`
- Modify: `packages/mcp/src/index.ts` (pass `log`)
- Test: `packages/mcp/test/markdown.test.ts`, `packages/mcp/test/server.test.ts`

**Interfaces:**
- Consumes: `sealRecord`, `openRecord` (Task 1); `KeyStore.ringFor`, `.file`, `.ringFromEnv`, `prefixOf` (Task 2); `PublishRequest.sealed` (Task 3).
- Produces:
  ```ts
  // markdown.ts
  export function documentTitle(html: string): string;   // <title> text, else first heading, else ""
  // server.ts
  export interface ServerDeps { api; keys; open?; stat?; log?: (line: string) => void }
  export const LINK_HINT: (url: string) => string;       // gains the ring sentence
  export function withRing(linkUrl: string, key: string, ring: string): string;  // appends #r=<prefixOf(key)>.<ring>
  export const RING_FILE_LINE: (file: string) => string;
  export const RING_ENV_LINE: string;
  ```

- [ ] **Step 1: Write the failing tests**

`packages/mcp/test/markdown.test.ts` — import `documentTitle` too, and add:

```ts
  it("documentTitle is the browser's pageTitle: the <title> text, else the first heading", () => {
    expect(documentTitle("<html><head><title> A &amp; <b>B</b>\n </title></head><body><h1>H</h1></body></html>")).toBe("A & B");
    expect(documentTitle("<html><head><title> </title></head><body><h2>Two <em>words</em></h2></body></html>")).toBe("Two words");
    expect(documentTitle("<p>none</p>")).toBe("");
  });
```

`packages/mcp/test/server.test.ts`:

1. Imports: add `readCredentials, writeCredentials` from `../src/credentials.js`, `newRing, openRecord` from `../src/crypto.js` (keep `openEnvelope`), and `RING_ENV_LINE, RING_FILE_LINE` beside `createServer` from `../src/server.js`.
2. Keep the credentials path: declare `let credFile: string;` beside `dir`, set `credFile = path.join(dir, "credentials.json");` in `beforeEach`, and build the `KeyStore` with `file: credFile`.
3. Add helpers under `text`:

```ts
const ringInFile = async () => (await readCredentials(credFile)).keys[fake.baseUrl]?.ring;
// The browser's #r= grammar (static/fmrl.js ringsFromFragment).
const RING_PAIR = /#r=([A-Za-z0-9_]{1,16})\.([A-Za-z0-9_-]{43})$/;
const keyOf = (q: { auth?: string }) => (q.auth as string).slice("Bearer ".length);
const connect = async (deps: ServerDeps): Promise<Client> => {
  const s = createServer(deps);
  const [c, t] = InMemoryTransport.createLinkedPair();
  await s.connect(t);
  const cl = new Client({ name: "extra", version: "0" });
  await cl.connect(c);
  return cl;
};
```

4. Update `"fmrl_publish mints a key on first use and returns url, expiry, the seven-days line and the manage link"`: after `const id = …`, add

```ts
    const prefix = keyOf(fake.requests[1]).slice(0, 9);
    const ring = await ringInFile();
    expect(ring).toMatch(/^[A-Za-z0-9_-]{43}$/);
```

and replace the last expected line with

```ts
      `See your pages on fmrl.site: open https://fmrl.test/link/code${id}#r=${prefix}.${ring} once in your browser (it works for an hour, and once). It also carries the ring that lets that browser open your private pages.`,
```

and add `expect(r.structuredContent).toMatchObject({ link_url: `https://fmrl.test/link/code${id}#r=${prefix}.${ring}` });`.

5. Update `"fmrl_whoami says whether a browser is linked and always offers a link"`: the first two expectations become

```ts
    expect(text(r)).toContain("open https://fmrl.test/link/fresh#r=");
    expect(r.structuredContent).toMatchObject({ linked_at: null, link_url: expect.stringMatching(/^https:\/\/fmrl\.test\/link\/fresh#r=/) });
```

6. Add these tests to `describe("tools", …)`:

```ts
  it("fmrl_publish private: seals the page's key and title under the ring, and the link carries that ring", async () => {
    const r = await call("fmrl_publish", { content: "# Quiet\n\nhello", private: true });
    expect(r.isError).toBeFalsy();
    const body = fake.requests[1].body as { sealed?: string };
    const pageKey = /#p=([A-Za-z0-9_-]{43})$/.exec((r.structuredContent as { url: string }).url)![1];
    const ring = (await ringInFile())!;
    expect(await openRecord(ring, body.sealed!)).toEqual({ key: pageKey, title: "Quiet" });
    const pair = RING_PAIR.exec((r.structuredContent as { link_url: string }).link_url)!;
    expect(pair[1]).toBe(keyOf(fake.requests[1]).slice(0, 9));
    expect(pair[2]).toBe(ring);
    // The ring shows in the reply only inside the link.
    expect(text(r).split(ring)).toHaveLength(2);
  });
  it("fmrl_publish private html: the record carries the explicit title, else the <title>", async () => {
    const html = "<!DOCTYPE html><html><head><title>Board notes</title></head><body><h1>Other</h1></body></html>";
    await call("fmrl_publish", { content: html, private: true });
    const ring = (await ringInFile())!;
    const first = fake.requests.at(-1)!.body as { sealed: string };
    expect((await openRecord(ring, first.sealed)).title).toBe("Board notes");
    await call("fmrl_publish", { content: html, private: true, title: "Custom" });
    const second = fake.requests.at(-1)!.body as { sealed: string };
    expect((await openRecord(ring, second.sealed)).title).toBe("Custom");
  });
  it("a publish with no link to relay mints no ring", async () => {
    const key = "fmrl_" + "L".repeat(32);
    await writeCredentials(credFile, { version: 1, keys: { [fake.baseUrl]: { key, prefix: key.slice(0, 9), created_at: "x" } } });
    fake.keys.add(key);
    fake.linked.add(key);
    const r = await call("fmrl_publish", { content: "# a" });
    expect(r.structuredContent).not.toHaveProperty("link_url");
    expect(await ringInFile()).toBeUndefined();
  });
  it("a retry after a 401 seals under the replacement key's ring", async () => {
    const oldRing = newRing();
    await writeCredentials(credFile, { version: 1, keys: { [fake.baseUrl]: { key: "fmrl_" + "S".repeat(32), prefix: "fmrl_SSSS", created_at: "x", ring: oldRing } } });
    const r = await call("fmrl_publish", { content: "# Again", private: true });
    expect(r.isError).toBeFalsy();
    const saved = await readCredentials(credFile);
    expect(saved.rings).toEqual({ fmrl_SSSS: oldRing });
    const ring = saved.keys[fake.baseUrl].ring!;
    const last = fake.requests.filter((q) => q.path === "/api/v1/publish").at(-1)!;
    const pageKey = /#p=([A-Za-z0-9_-]{43})$/.exec((r.structuredContent as { url: string }).url)![1];
    expect(await openRecord(ring, (last.body as { sealed: string }).sealed)).toEqual({ key: pageKey, title: "Again" });
    expect(RING_PAIR.exec((r.structuredContent as { link_url: string }).link_url)![2]).toBe(ring);
  });
  it("a ring that cannot be saved never costs the publish", async () => {
    const blocker = path.join(dir, "not-a-dir");
    await writeFile(blocker, "x");
    const envKey = "fmrl_" + "N".repeat(32);
    fake.keys.add(envKey);
    const logs: string[] = [];
    const api2 = new FmrlApi(fake.baseUrl);
    const keys2 = new KeyStore({ api: api2, baseUrl: fake.baseUrl, file: path.join(blocker, "credentials.json"), apiKeyFromEnv: envKey });
    const client2 = await connect({ api: api2, keys: keys2, log: (s) => logs.push(s) });
    try {
      const r = (await client2.callTool({ name: "fmrl_publish", arguments: { content: "# Still", private: true } })) as ToolResult;
      expect(r.isError).toBeFalsy();
      expect(fake.requests.at(-1)!.body as Record<string, unknown>).not.toHaveProperty("sealed");
      expect((r.structuredContent as { url: string }).url).toMatch(/#p=[A-Za-z0-9_-]{43}$/);
      expect((r.structuredContent as { link_url: string }).link_url).not.toContain("#r=");
      expect(logs.join("\n")).toMatch(/couldn't save a key ring/);
      const who = (await client2.callTool({ name: "fmrl_whoami", arguments: {} })) as ToolResult;
      expect(text(who)).toContain(`Couldn't save a key ring to ${path.join(blocker, "credentials.json")} (`);
    } finally {
      await client2.close();
    }
  });
  it("fmrl_publish private: a title that seals over 1 KiB is refused before publishing", async () => {
    const r = await call("fmrl_publish", { content: "# x", private: true, title: "\u0001".repeat(200) });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/over the 1024-byte limit; pass a shorter title\.$/);
    expect(fake.requests.some((q) => q.path === "/api/v1/publish")).toBe(false);
  });
  it("fmrl_whoami mints the ring, carries it on the link, and names the file to back up", async () => {
    const r = await call("fmrl_whoami");
    expect(r.isError).toBeFalsy();
    const ring = (await ringInFile())!;
    const prefix = keyOf(fake.requests.at(-1)!).slice(0, 9);
    expect(ring).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(r.structuredContent).toMatchObject({ link_url: `https://fmrl.test/link/fresh#r=${prefix}.${ring}` });
    expect(text(r)).toContain(`open https://fmrl.test/link/fresh#r=${prefix}.${ring} (works for an hour, and once). It also carries the ring that lets that browser open your private pages.`);
    expect(text(r)).toContain(RING_FILE_LINE(credFile));
    expect(RING_FILE_LINE(credFile)).toBe(`Your key ring is in ${credFile}; back up that file to keep every page's key.`);
    expect(text(r).split(ring)).toHaveLength(2);
  });
  it("fmrl_whoami with FMRL_RING carries that ring and says where it comes from", async () => {
    const envRing = newRing();
    const api2 = new FmrlApi(fake.baseUrl);
    const keys2 = new KeyStore({ api: api2, baseUrl: fake.baseUrl, file: path.join(dir, "env-ring.json"), ringFromEnv: envRing });
    const client2 = await connect({ api: api2, keys: keys2 });
    try {
      const r = (await client2.callTool({ name: "fmrl_whoami", arguments: {} })) as ToolResult;
      expect(RING_PAIR.exec((r.structuredContent as { link_url: string }).link_url)![2]).toBe(envRing);
      expect(text(r)).toContain(RING_ENV_LINE);
      expect(text(r)).not.toContain("Your key ring is in");
    } finally {
      await client2.close();
    }
  });
```

- [ ] **Step 2: Run them to see them fail**

Run: `cd packages/mcp && npx vitest run test/markdown.test.ts test/server.test.ts`
Expected: FAIL — `documentTitle`, `RING_FILE_LINE`, `RING_ENV_LINE` are not exported; no `sealed` is sent; no `#r=` on any link.

- [ ] **Step 3: Implement `documentTitle`** — in `packages/mcp/src/markdown.ts`, after `firstHeading`:

```ts
/** documentTitle is the browser's pageTitle (static/fmrl.js): the <title> text, tags stripped, whitespace collapsed and entities decoded, else the first heading, else "". It names a private HTML page in its sealed record. */
export function documentTitle(html: string): string {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const t = m ? decodeEntities(m[1].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim()) : "";
  return t || firstHeading(html);
}
```

- [ ] **Step 4: Implement in `packages/mcp/src/server.ts`**

Imports:

```ts
import { ApiError, type DocResponse, type FmrlApi, type MeResponse, type PublishRequest, type PublishResponse } from "./api.js";
import { seal, sealRecord } from "./crypto.js";
import { MAX_BYTES, TOO_LARGE_MESSAGE, formatForPath } from "./format.js";
import { parseDocId } from "./ids.js";
import { prefixOf, type KeyStore } from "./keys.js";
import { documentTitle, firstHeading, looksLikeHTML, toHTML, wrapDocument } from "./markdown.js";
```

`ServerDeps` gains `log?: (line: string) => void;` (stderr in `index.ts`).

Replace `LINK_HINT` and add, right after it:

```ts
export const LINK_HINT = (url: string) => `See your pages on fmrl.site: open ${url} once in your browser (it works for an hour, and once). It also carries the ring that lets that browser open your private pages.`;

/** withRing appends key's ring to a browser link as #r=<prefix>.<ring>. The link page stores it for the key its form names; the server never sees a fragment. */
export function withRing(linkUrl: string, key: string, ring: string): string {
  return `${linkUrl}${linkUrl.includes("#") ? "&" : "#"}r=${prefixOf(key)}.${ring}`;
}
export const RING_FILE_LINE = (file: string) => `Your key ring is in ${file}; back up that file to keep every page's key.`;
export const RING_ENV_LINE = "Your key ring comes from FMRL_RING; back up that value to keep every page's key.";
const RING_UNSAVED_LINE = (file: string, why: string) => `Couldn't save a key ring to ${file} (${why}); private pages publish without their key sealed until it can be written, or FMRL_RING is set.`;
```

Replace `preparePrivate` so it also returns the record's title:

```ts
/** preparePrivate renders (if Markdown) and seals content, returning the request body, the link key, and the title the sealed record carries: the title given, else the first heading for Markdown, else the document's <title> or first heading for HTML. The request body never carries a title. */
async function preparePrivate(content: string, format: "html" | "md" | undefined, title: string | undefined): Promise<{ body: { content: string; format: "html"; encrypted: true }; key: string; title: string }> {
  let html = content;
  let name: string;
  if (format === "md" || (format === undefined && !looksLikeHTML(content))) {
    const body = toHTML(content);
    if (body.trim() === "") {
      throw new Error("Nothing to publish: the content rendered to an empty page.");
    }
    name = title || firstHeading(body);
    html = wrapDocument(body, name);
  } else {
    name = title || documentTitle(content);
  }
  const sealed = await seal(html);
  const envBytes = Buffer.byteLength(sealed.envelope, "utf8");
  if (envBytes > MAX_BYTES) {
    throw new Error(`The encrypted page is ${envBytes} bytes, over the 2 MiB limit. Encryption adds about a third, so roughly 1.4 MB of HTML fits.`);
  }
  return { body: { content: sealed.envelope, format: "html", encrypted: true }, key: sealed.key, title: name };
}
```

Replace `meText`:

```ts
function meText(m: MeResponse, ringLine: string): string {
  const q = m.quota.publishes;
  const linked = m.linked_at ? `Linked to a browser on ${m.linked_at}.` : "Not linked to any browser yet.";
  const lines = [`${m.prefix}…: ${q.used} of ${q.limit} publishes used this month, resets ${q.resets_at}.`, linked];
  if (m.link_url) lines.push(`To see this key's pages on fmrl.site, open ${m.link_url} (works for an hour, and once). It also carries the ring that lets that browser open your private pages.`);
  return [...lines, ringLine, SEVEN_DAYS].join("\n");
}
```

In `createServer`, after `const server = …`:

```ts
  const log = deps.log;

  /** ringOrNothing is keys.ringFor for a caller that must not fail on it: a page goes out without a sealed record, and a link without a ring, rather than not at all. */
  const ringOrNothing = async (k: string): Promise<string | undefined> => {
    try {
      return await keys.ringFor(k);
    } catch (e) {
      log?.(`fmrl-mcp: couldn't save a key ring to ${keys.file}: ${errorText(e)}`);
      return undefined;
    }
  };

  /**
   * publishAs publishes body as key k. A private page (secret set) carries
   * its key and title sealed under k's ring; a link_url in the answer gets
   * #r= so the browser that redeems it holds the ring too. It runs inside
   * withKey, so a retry after a 401 seals under the replacement key's ring.
   */
  const publishAs = async (k: string, body: PublishRequest, secret?: { key: string; title: string }): Promise<PublishResponse> => {
    let ring: string | undefined;
    if (secret) {
      ring = await ringOrNothing(k);
      if (ring) body = { ...body, sealed: await sealRecord(ring, secret.key, secret.title) };
    }
    const p = await api.publish(k, body);
    if (!p.link_url) return p;
    ring ??= await ringOrNothing(k);
    return ring ? { ...p, link_url: withRing(p.link_url, k, ring) } : p;
  };
```

In `publishOrSeal`, the public branch becomes

```ts
      return run<PublishResponse & Record<string, unknown>>(async (k) => (await publishAs(k, { content, format, title })) as PublishResponse & Record<string, unknown>, publishText);
```

and the private `run` becomes

```ts
    return run<PublishResponse & Record<string, unknown>>(
      async (k) => withFragment(await publishAs(k, prepared.body, { key: prepared.key, title: prepared.title }), prepared.key) as PublishResponse & Record<string, unknown>,
      privateText,
    );
```

Replace the `fmrl_whoami` registration's description and handler:

```ts
      description: "The key's prefix, how many of this month's free publishes it has used, whether a browser is linked to it, a fresh link to link one (it carries the key ring), and where the key ring is kept.",
```

```ts
    async () => {
      let ringLine = "";
      return run<MeResponse & Record<string, unknown>>(async (k) => {
        const me = await api.me(k);
        let ring: string | undefined;
        try {
          ring = await keys.ringFor(k);
          ringLine = keys.ringFromEnv ? RING_ENV_LINE : RING_FILE_LINE(keys.file);
        } catch (e) {
          ringLine = RING_UNSAVED_LINE(keys.file, errorText(e));
        }
        return (me.link_url && ring ? { ...me, link_url: withRing(me.link_url, k, ring) } : me) as MeResponse & Record<string, unknown>;
      }, (m) => meText(m, ringLine));
    },
```

In `packages/mcp/src/index.ts`: `const server = createServer({ api, keys, log });`

- [ ] **Step 5: Run the tests and the suite**

Run: `cd packages/mcp && npx vitest run test/markdown.test.ts test/server.test.ts && npm test && npm run typecheck`
Expected: PASS (9 new tests; 105 total), typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add packages/mcp/src/markdown.ts packages/mcp/src/server.ts packages/mcp/src/index.ts packages/mcp/test/markdown.test.ts packages/mcp/test/server.test.ts
git commit -m "mcp: private publishes seal their key under the ring; #r= on every browser link; whoami names the ring file

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 5: `fmrl_list`, and `fmrl_get` unseals

**Files:**
- Modify: `packages/mcp/src/server.ts`
- Test: `packages/mcp/test/server.test.ts`

**Interfaces:**
- Consumes: `openRecord`, `OpenedRecord` (Task 1); `KeyStore.ringsFor` (Task 2); `FmrlApi.list`, `DocResponse.private`/`.sealed` (Task 3); `SEVEN_DAYS`, `SEVEN_DAYS_PRIVATE` (existing).
- Produces: tool `fmrl_list` (no input) → `{ docs: PageRow[] }`; tool `fmrl_get` → `PageRow`; exported `NOT_HELD_LINE`, `LIST_EMPTY`.
  ```ts
  type PageRow = { id: string; url: string; status: string; format: string; size: number; expires_at: string | null;
    pinned: boolean; cid?: string; private: boolean; key_held?: boolean; title?: string };
  // url carries #p=<key> exactly when key_held; key_held and title appear on private rows only.
  ```

- [ ] **Step 1: Write the failing tests** — in `packages/mcp/test/server.test.ts` import `sealRecord` (crypto) and `LIST_EMPTY, NOT_HELD_LINE, SEVEN_DAYS_PRIVATE` (server). Change `"lists exactly the five contract tools"` to:

```ts
  it("lists exactly the six tools", async () => {
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual(["fmrl_delete", "fmrl_get", "fmrl_list", "fmrl_publish", "fmrl_publish_file", "fmrl_whoami"]);
  });
```

and add:

```ts
  it("fmrl_list says so when the key has no pages", async () => {
    const r = await call("fmrl_list");
    expect(r.isError).toBeFalsy();
    expect(text(r)).toBe(LIST_EMPTY);
    expect(r.structuredContent).toEqual({ docs: [] });
  });
  it("fmrl_list hands back a private page's title and keyed link, and a public page's url, newest first", async () => {
    const pub = await call("fmrl_publish", { content: "# Open" });
    const priv = await call("fmrl_publish", { content: "# Quiet\n\nhello", private: true });
    const pubId = (pub.structuredContent as { id: string }).id;
    const { id: privId, url: privUrl } = priv.structuredContent as { id: string; url: string };
    const r = await call("fmrl_list");
    expect(text(r).split("\n")).toEqual([
      "2 pages on this key, newest first:",
      `- Quiet — ${privUrl} — expires 2026-09-15T12:00:00Z`,
      `- https://fmrl.test/${pubId} — expires 2026-09-15T12:00:00Z`,
    ]);
    const docs = (r.structuredContent as { docs: Array<Record<string, unknown>> }).docs;
    expect(docs[0]).toMatchObject({ id: privId, url: privUrl, private: true, key_held: true, title: "Quiet" });
    expect(docs[0]).not.toHaveProperty("sealed");
    expect(docs[1]).toMatchObject({ id: pubId, url: `https://fmrl.test/${pubId}`, private: false });
    expect(docs[1]).not.toHaveProperty("key_held");
    expect(fake.requests.at(-1)).toMatchObject({ method: "GET", path: "/api/v1/docs" });
  });
  it("fmrl_list names a page whose key it cannot open, and opens one under a replaced key's ring", async () => {
    const mine = await call("fmrl_publish", { content: "# Mine", private: true });
    const mineUrl = (mine.structuredContent as { url: string }).url;
    const key = keyOf(fake.requests.at(-1)!);
    const oldRing = newRing();
    const saved = await readCredentials(credFile);
    saved.rings = { fmrl_OLD1: oldRing };
    await writeCredentials(credFile, saved);
    const doc = (id: string, extra: Partial<{ sealed: string; status: string; owner: string }>) =>
      fake.docs.set(id, { id, owner: key, format: "html", size: 1, encrypted: true, ...extra });
    doc("aaaaaaaaaaaa", { sealed: await sealRecord(newRing(), "A".repeat(43), "Theirs") });
    doc("bbbbbbbbbbbb", {});
    doc("cccccccccccc", { sealed: await sealRecord(oldRing, "B".repeat(43), "Before"), status: "quarantined" });
    doc("dddddddddddd", { owner: "fmrl_" + "Z".repeat(32) });
    expect(text(await call("fmrl_list")).split("\n")).toEqual([
      "4 pages on this key, newest first:",
      `- Before — https://fmrl.test/cccccccccccc#p=${"B".repeat(43)} — expires 2026-09-15T12:00:00Z, quarantined`,
      "- private page (key not held here) — https://fmrl.test/bbbbbbbbbbbb — expires 2026-09-15T12:00:00Z",
      "- private page (key not held here) — https://fmrl.test/aaaaaaaaaaaa — expires 2026-09-15T12:00:00Z",
      `- Mine — ${mineUrl} — expires 2026-09-15T12:00:00Z`,
    ]);
  });
  it("fmrl_get hands back a private page's title and keyed link to the key that owns it", async () => {
    const priv = await call("fmrl_publish", { content: "# Quiet", private: true });
    const { id, url } = priv.structuredContent as { id: string; url: string };
    const got = await call("fmrl_get", { id });
    expect(got.isError).toBeFalsy();
    const [first, second, extra] = text(got).split("\n");
    expect(first.startsWith(`Quiet — ${url}: live, html, `)).toBe(true);
    expect(first.endsWith(" bytes, expires 2026-09-15T12:00:00Z.")).toBe(true);
    expect(second).toBe(SEVEN_DAYS_PRIVATE);
    expect(extra).toBeUndefined();
    expect(got.structuredContent).toMatchObject({ id, url, private: true, key_held: true, title: "Quiet" });
    expect(got.structuredContent).not.toHaveProperty("sealed");
  });
  it("fmrl_get says a private page's key is not held here when another key owns it", async () => {
    const priv = await call("fmrl_publish", { content: "# Theirs", private: true });
    const id = (priv.structuredContent as { id: string }).id;
    fake.docs.get(id)!.owner = "fmrl_" + "Z".repeat(32);
    const got = await call("fmrl_get", { id });
    expect(got.isError).toBeFalsy();
    expect(text(got)).toContain(NOT_HELD_LINE);
    expect(text(got)).toContain(SEVEN_DAYS_PRIVATE);
    expect(got.structuredContent).toMatchObject({ id, url: `https://fmrl.test/${id}`, private: true, key_held: false });
  });
```

- [ ] **Step 2: Run them to see them fail**

Run: `cd packages/mcp && npx vitest run test/server.test.ts`
Expected: FAIL — no `fmrl_list` tool; `LIST_EMPTY`/`NOT_HELD_LINE` not exported; `fmrl_get` has no `private`/`key_held`/`title`.

- [ ] **Step 3: Implement in `packages/mcp/src/server.ts`**

Import `openRecord, seal, sealRecord, type OpenedRecord` from `./crypto.js`. Replace `docText` (and move it below `SEVEN_DAYS_PRIVATE`, which it now reads) with:

```ts
/** unseal opens a sealed record with the first ring that fits, or answers undefined: a page whose key this machine does not hold. */
async function unseal(rings: string[], sealed: string | undefined): Promise<OpenedRecord | undefined> {
  if (!sealed) return undefined;
  for (const ring of rings) {
    try {
      return await openRecord(ring, sealed);
    } catch {
      // Not this ring.
    }
  }
  return undefined;
}

/** PageRow is a page as fmrl_get and fmrl_list hand it back: the API's description minus the sealed record. A private page whose record opened here carries its title, and its keyed link as url. */
type PageRow = {
  id: string; url: string; status: string; format: string; size: number; expires_at: string | null;
  pinned: boolean; cid?: string; private: boolean; key_held?: boolean; title?: string;
};

function pageRow(d: DocResponse, opened: OpenedRecord | undefined): PageRow {
  const row: PageRow = { id: d.id, url: d.url, status: d.status, format: d.format, size: d.size, expires_at: d.expires_at, pinned: d.pinned, private: d.private === true };
  if (d.cid) row.cid = d.cid;
  if (row.private) {
    row.key_held = opened !== undefined;
    if (opened) {
      row.url = `${d.url}#p=${opened.key}`;
      row.title = opened.title;
    }
  }
  return row;
}

export const NOT_HELD_LINE = "This page is private and its key is not held here: it opens from its link, or from a browser linked to the key that published it.";

function docText(r: PageRow): string {
  const kept = r.pinned ? `kept forever${r.cid ? ` (${r.cid})` : ""}` : `expires ${r.expires_at}`;
  const name = r.key_held && r.title ? `${r.title} — ` : "";
  const lines = [`${name}${r.url}: ${r.status}, ${r.format}, ${r.size} bytes, ${kept}.`];
  if (r.private && !r.key_held) lines.push(NOT_HELD_LINE);
  lines.push(r.private ? SEVEN_DAYS_PRIVATE : SEVEN_DAYS);
  return lines.join("\n");
}

export const LIST_EMPTY = "This key has no pages right now; removed and expired pages are not listed.";

function when(r: PageRow): string {
  const life = r.pinned ? "kept" : `expires ${r.expires_at}`;
  return r.status === "live" || r.status === "pinned" ? life : `${life}, ${r.status}`;
}
function listLine(r: PageRow): string {
  if (!r.private) return `- ${r.url} — ${when(r)}`;
  if (!r.key_held) return `- private page (key not held here) — ${r.url} — ${when(r)}`;
  return `- ${r.title || "untitled private page"} — ${r.url} — ${when(r)}`;
}
function listText(rows: PageRow[]): string {
  if (rows.length === 0) return LIST_EMPTY;
  const count = rows.length === 1 ? "1 page" : `${rows.length} pages`;
  return [`${count} on this key, newest first${rows.length >= 50 ? " (the newest 50)" : ""}:`, ...rows.map(listLine)].join("\n");
}
```

Replace `docOutput` with a shared page shape and add the list output:

```ts
const pageOutput = {
  id: z.string(), url: z.string(), status: z.string(), format: z.string(), size: z.number(),
  expires_at: z.string().nullable(), pinned: z.boolean(), cid: z.string().optional(),
  private: z.boolean(), key_held: z.boolean().optional(), title: z.string().optional(),
};
const listOutput = { docs: z.array(z.object(pageOutput)) };
```

Update the `createServer` doc comment to "the six tools". `fmrl_get` becomes:

```ts
  server.registerTool(
    "fmrl_get",
    {
      title: "Describe a fmrl.site page",
      description: "Look up a page by id or URL: status, format, size, expiry, and whether it has been kept. For a private page this key owns, also its title and its link with the key after #p=, when this machine holds the key ring.",
      inputSchema: { id: z.string().min(1).describe("A document id or any fmrl.site URL for it.") },
      outputSchema: pageOutput,
    },
    async ({ id }) => {
      let docId: string;
      try { docId = parseDocId(id); } catch (e) { return fail(errorText(e)); }
      return run<PageRow>(async (k) => {
        const d = await api.get(k, docId);
        return pageRow(d, d.private ? await unseal(await keys.ringsFor(k), d.sealed) : undefined);
      }, docText);
    },
  );

  server.registerTool(
    "fmrl_list",
    {
      title: "List this key's fmrl.site pages",
      description: "List the pages this key owns, newest first (50 at most): published through it, or shared from a browser linked to it. A private page comes back with its title and its link with the key after #p= when this machine holds the key ring. Use it when the user asks for a page they shared earlier.",
      inputSchema: {},
      outputSchema: listOutput,
    },
    async () => run<{ docs: PageRow[] }>(async (k) => {
      const [{ docs }, rings] = await Promise.all([api.list(k), keys.ringsFor(k)]);
      return { docs: await Promise.all(docs.map(async (d) => pageRow(d, d.private ? await unseal(rings, d.sealed) : undefined))) };
    }, (v) => listText(v.docs)),
  );
```

- [ ] **Step 4: Run the tests and the suite**

Run: `cd packages/mcp && npx vitest run test/server.test.ts && npm test && npm run typecheck`
Expected: PASS (5 new tests; 110 total), typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add packages/mcp/src/server.ts packages/mcp/test/server.test.ts
git commit -m "mcp: fmrl_list hands every page back, a private one by name with its keyed link; fmrl_get unseals

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 6: The skill, the READMEs, 0.5.0, and the e2e script

**Files:**
- Modify: `plugins/fmrl/skills/share/SKILL.md`
- Modify: `README.md`, `packages/mcp/README.md`
- Modify: `packages/mcp/package.json`, `packages/mcp/package-lock.json` (0.5.0)
- Modify: `packages/mcp/scripts/e2e.mjs`

**Interfaces:**
- Consumes: the tool names and copy from Tasks 4–5.
- Produces: documentation and the release version; `e2e.mjs` exits non-zero when a check fails.

- [ ] **Step 1: The skill** — in `plugins/fmrl/skills/share/SKILL.md`:

Step 1 begins with this sentence (before "Decide what to publish…"):

```markdown
1. If the user asks for a page they shared earlier, call `fmrl_list` and hand back its link instead of publishing again; a private page comes back with its key after `#p=` when this machine holds it. Otherwise, decide what to publish using the fmrl MCP tools (`fmrl_publish_file`, `fmrl_publish`). …
```

(the rest of step 1 unchanged). In step 2, replace the last sentence with:

```markdown
If the tool result carries a line starting *See your pages on fmrl.site*, relay it once in this session and not again, with its link unchanged — it is how the person's own browser comes to hold these pages, and the part after `#r=` is what lets that browser open the private ones.
```

In *Never*, after the `#p=` line, add:

```markdown
- Never print the ring on its own: it travels only inside the browser link, after `#r=`, and that part is never stripped when relaying the link.
```

- [ ] **Step 2: Both READMEs** (`README.md` and `packages/mcp/README.md`, the same edits):

- "Any MCP client gets five tools:" → "Any MCP client gets six tools:".
- `fmrl_publish` row: replace "plus a one-time browser link until a browser is linked to the key" with "plus a one-time browser link, carrying the key ring after `#r=`, until a browser is linked to the key".
- `fmrl_get` row: `| \`fmrl_get\` | an id or a viewer URL → status, format, size, expiry, whether it was kept; for a private page this key owns, its title and its link with the key after \`#p=\` |`
- New row after `fmrl_get`: `| \`fmrl_list\` | nothing → every page this key owns, newest first (50 at most); a private page with its title and keyed link when this machine holds the key ring |`
- `fmrl_whoami` row: `| \`fmrl_whoami\` | the key's prefix, this month's quota, whether a browser is linked to it, a fresh link to link one when the server offers it (carrying the key ring after \`#r=\`), and where the key ring is kept |`
- *Keys and limits*: after "`FMRL_API_KEY` overrides the file." insert: "A private page's key travels with it, sealed under a key ring kept in the same file (`FMRL_RING` overrides it) and handed to a browser only inside the link, so fmrl.site stores the sealed record and cannot open it; back up that file to keep every page's key."

- [ ] **Step 3: The version**

Run: `cd packages/mcp && npm version 0.5.0 --no-git-tag-version`
Expected: `v0.5.0`; `package.json` and both `"version"` fields at the top of `package-lock.json` read `0.5.0`. The server reports it at runtime (`createRequire` of package.json), so nothing else changes.

- [ ] **Step 4: The e2e script** — replace `packages/mcp/scripts/e2e.mjs` with:

```js
#!/usr/bin/env node
// e2e: talk to the built server over stdio against FMRL_API_URL — publish a
// file and a private page, and list them back with the sealed record opened.
// It mints a real key and publishes real pages wherever FMRL_API_URL points,
// so it refuses to run without one: point it at a local markymd.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

if (!process.env.FMRL_API_URL) {
  console.error("Set FMRL_API_URL (a local server, e.g. http://fmrl.localhost:8080): this script mints a key and publishes real pages.");
  process.exit(2);
}
let failed = 0;
const check = (ok, what) => { console.log(`${ok ? "ok  " : "FAIL"} ${what}`); if (!ok) failed++; };

const dir = mkdtempSync(path.join(tmpdir(), "fmrl-e2e-"));
const file = path.join(dir, "hello.md");
writeFileSync(file, "# Hello from fmrl-mcp\n\nPublished through the MCP server end to end.\n");
const transport = new StdioClientTransport({ command: "node", args: [new URL("../dist/index.js", import.meta.url).pathname], env: { ...process.env, XDG_CONFIG_HOME: dir, APPDATA: dir } });
const client = new Client({ name: "e2e", version: "0" });
await client.connect(transport);
const tools = (await client.listTools()).tools.map((t) => t.name);
console.log("tools:", tools.join(" "));
check(tools.includes("fmrl_list"), "fmrl_list is offered");
const who = await client.callTool({ name: "fmrl_whoami", arguments: {} });
console.log("whoami:", who.content[0].text.split("\n")[0]);
check(!who.isError && who.content[0].text.includes("Your key ring is in "), "whoami names the ring file");
const pub = await client.callTool({ name: "fmrl_publish_file", arguments: { path: file } });
console.log(pub.isError ? "publish FAILED: " + pub.content[0].text : "publish:\n" + pub.content[0].text);
check(!pub.isError, "public publish");
const id = pub.structuredContent?.id;
if (id) {
  const got = await client.callTool({ name: "fmrl_get", arguments: { id } });
  console.log("get:", got.content[0].text.split("\n")[0]);
}
const priv = await client.callTool({ name: "fmrl_publish", arguments: { content: "# Private from fmrl-mcp\n\nSealed end to end.", private: true } });
check(!priv.isError, "private publish with a sealed record" + (priv.isError ? ": " + priv.content[0].text : ""));
const keyed = priv.structuredContent?.url ?? "";
check(/#p=[A-Za-z0-9_-]{43}$/.test(keyed), "the private link carries its key after #p=");
for (const link of [who.structuredContent?.link_url, pub.structuredContent?.link_url, priv.structuredContent?.link_url].filter(Boolean)) {
  check(/#r=[A-Za-z0-9_]{1,16}\.[A-Za-z0-9_-]{43}$/.test(link), "a browser link carries the ring after #r=");
}
const list = await client.callTool({ name: "fmrl_list", arguments: {} });
console.log("list:\n" + list.content[0].text);
const row = (list.structuredContent?.docs ?? []).find((d) => d.id === priv.structuredContent?.id);
check(row?.url === keyed && row?.title === "Private from fmrl-mcp", "fmrl_list opens the sealed record: title and keyed link");
const privGot = await client.callTool({ name: "fmrl_get", arguments: { id: priv.structuredContent?.id ?? "x" } });
check(privGot.structuredContent?.url === keyed, "fmrl_get opens it too");
await client.close();
process.exit(failed ? 1 : 0);
```

- [ ] **Step 5: Run the suite and the build**

Run: `cd packages/mcp && npm test && npm run typecheck && npm run build && node scripts/e2e.mjs; echo "exit $?"`
Expected: tests PASS (110), typecheck clean, build clean; the e2e line prints the `Set FMRL_API_URL…` refusal and `exit 2` (FMRL_API_URL unset — this is the guard, not a real run).

- [ ] **Step 6: Commit**

```bash
git add plugins/fmrl/skills/share/SKILL.md README.md packages/mcp/README.md packages/mcp/package.json packages/mcp/package-lock.json packages/mcp/scripts/e2e.mjs
git commit -m "mcp: 0.5.0 — the skill reaches for fmrl_list and keeps #r=; READMEs; e2e covers the ring and refuses a default host

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 7: Verify against a local server, push, open the draft PR

**Files:** none committed (a scratch markymd worktree under `/tmp` is created and removed).

- [ ] **Step 1: CI's checks, from clean**

Run: `cd packages/mcp && npm ci && npm test && npm run typecheck && npm run build`
Expected: 110 tests pass; typecheck and build clean.

- [ ] **Step 2: The fixture is still the server's bytes**

Run: `git -C ~/projects/markymd fetch origin main`, then `git -C ~/projects/markymd show origin/main:internal/crypto/testdata/sealed.json | sha256sum` and `sha256sum packages/mcp/test/fixtures/sealed.json`
Expected: identical hashes.

- [ ] **Step 3: STOP — ask Marty before running `scripts/e2e.mjs`** (AskUserQuestion). Proceed only on a yes, and only against the local server below.

- [ ] **Step 4: Build and start markymd `origin/main` in a scratch worktree**

```bash
git -C ~/projects/markymd worktree add --detach /tmp/markymd-pr3 origin/main
```

Then, from `/tmp/markymd-pr3`: `$(go env GOPATH)/bin/templ generate` and `go build -o bin/markymd ./cmd/server`, and start it in the background with the env line from markymd's `e2e/playwright.config.ts` plus `PINATA_JWT=` and `PORT=8097` (ruling 9):

```bash
PORT=8097 PINATA_JWT= FMRL_HOST=fmrl.localhost MARKY_HOST=localhost DEFAULT_SITE=marky STORE=memory SHARES_PER_HOUR=1000 API_KEYS_PER_DAY=1000 SESSION_SECRET=e2e-session-secret-0123456789abcdef CLIENT_IP_HEADER=X-Test-IP TRUSTED_PROXIES=127.0.0.1/32,::1/128 ./bin/markymd
```

Check: `curl -s http://fmrl.localhost:8097/api/v1/openapi.json | head -c 200` answers JSON. If Node cannot resolve `fmrl.localhost` (`getent hosts fmrl.localhost` empty), use `http://localhost:8097` for `FMRL_API_URL` — the API answers on both hosts.

- [ ] **Step 5: Run the e2e against it**

Run: `cd packages/mcp && FMRL_API_URL=http://fmrl.localhost:8097 node scripts/e2e.mjs; echo "exit $?"`
Expected: every line `ok`, `exit 0` — the real server accepted `sealed` (Go's `ValidateSealed`), `link_url` carries `#r=`, and `fmrl_list` opened the record it stored.

- [ ] **Step 6: Go opens a plugin-sealed record, once, by hand**

Seal with the built plugin under the fixture's ring:

```bash
cd packages/mcp && node --input-type=module -e 'import { sealRecord } from "./dist/crypto.js"; import fs from "node:fs"; const fx = JSON.parse(fs.readFileSync("test/fixtures/sealed.json", "utf8")); console.log(await sealRecord(fx.ring, fx.record.k, "Plugin → Go 🙂"));'
```

In `/tmp/markymd-pr3`, create `cmd/pr3check/main.go`:

```go
package main

import (
	"encoding/base64"
	"fmt"
	"os"

	"github.com/itsnoproblem/markymd/internal/crypto"
)

func main() {
	ring, err := base64.RawURLEncoding.DecodeString(os.Args[1])
	if err != nil {
		panic(err)
	}
	rec, err := crypto.OpenRecord(ring, os.Args[2])
	if err != nil {
		panic(err)
	}
	fmt.Printf("%+v\n", rec)
}
```

Run: `go run ./cmd/pr3check BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc <the record printed above>`
Expected: `{Key:AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8 Title:Plugin → Go 🙂}`.

- [ ] **Step 7: Tear down** — stop the server (kill its PID), then `git -C ~/projects/markymd worktree remove --force /tmp/markymd-pr3`. Confirm `git -C ~/projects/markymd worktree list` no longer shows it.

- [ ] **Step 8: Verify the base and the branch**

Run: `git fetch origin main`, `git log --oneline origin/main..HEAD`, `git status --short`
Expected: exactly this plan's seven commits (Task 0–6), a clean tree, on `claude/key-durability-plugin`, based on the current `origin/main` (rebase if main moved).

- [ ] **Step 9: Push and open the draft PR**

```bash
git push -u origin claude/key-durability-plugin
```

Title: `mcp 0.5.0: a key ring beside the key — private pages' keys travel sealed, fmrl_list hands them back`

Body (mirror PR #7's sections):

```markdown
The plugin's half of "fmrl: Key Durability for Private Pages" — PR 3 of 3 (spec §1, §2, §7, §8, §9's Node bullet, §12 step 3 in markymd's `docs/superpowers/specs/2026-09-18-fmrl-key-durability-design.md`). Server: toogreatwtf/markymd#71; browser: toogreatwtf/markymd#73; both merged.

## What changes

- **The ring.** Each API key gets one random 256-bit key ring, kept beside it in `credentials.json` (`ring`; still `version: 1`, still 0600) — minted the first time a private page is sealed, a browser link is relayed, or `fmrl_whoami` runs. `FMRL_RING` overrides it and is never written. An env-supplied key's ring, and a key's ring after a 401 replaces the key, live in a `rings` map by key prefix.
- **`sealed` on publish.** A private page's key and title are sealed under the ring (`base64url(nonce||AES-256-GCM({"k","t"}))`, ≤ 1 KiB) and sent as `sealed`; fmrl.site stores it and cannot open it. Sealing happens inside the 401 retry, so a replacement key seals under its own ring.
- **`#r=` on every browser link** the plugin relays (publish and `fmrl_whoami`): `#r=<prefix>.<ring>`, the pair the link page stores, so a browser linked from here opens the agent's private pages by name.
- **`fmrl_list`** (new): every page this key owns; a private page with its title and `#p=` link when the ring opens its record. **`fmrl_get`** does the same for one page.
- **`fmrl_whoami`** names the file: "Your key ring is in {file}; back up that file to keep every page's key." — now the only place that sentence lives (markymd #73 dropped it from the drawer).
- The share skill reaches for `fmrl_list` for an earlier page and never prints or strips the ring; READMEs; `scripts/e2e.mjs` covers the ring and refuses to run without an explicit `FMRL_API_URL`; `fmrl-mcp` 0.4.0 → 0.5.0.

## Rulings against the spec

Each is argued in the plan (`docs/superpowers/plans/2026-09-21-fmrl-key-durability-plugin.md`):

1. `fmrl_list`'s public rows carry no title — the API row has none.
2. A ring is minted whenever one must seal or travel, a relayed link on a public publish included (§1 names only a private publish and whoami).
3. A ring that can't be saved never costs a publish: the page goes out without `sealed`, as 0.4.0 did, and `fmrl_whoami` says why. An oversize record still fails the publish before any request.
4. With `FMRL_RING`, whoami says the ring comes from `FMRL_RING` instead of naming the file.
5. The skill's `fmrl_list` sentence sits in step 1, and "never print the ring" is worded so it can't be read as "strip `#r=`".
6. Whoami's own link line gains the ring sentence; `fmrl_get` on a private page says it cannot be kept.
7. The fixture is copied, not generated; §9's "from `go test`" is met by vitest on the same bytes, a `node:crypto` opener, and a one-off Go open.
8. `scripts/e2e.mjs` refuses to run without an explicit `FMRL_API_URL`.
9. The local e2e ran on port 8097, off the port other sessions' Playwright reuses.

## Shipping order

Production must serve markymd #71 before this is published: a 0.5.0 plugin against a server without it would 400 every private publish (`sealed` unknown). As of 2026-09-21 it does — `GET https://fmrl.site/api/v1/openapi.json` lists `/docs`. `plugins/fmrl/.mcp.json` runs `npx -y fmrl-mcp` unpinned, so the npm publish changes every installed plugin at once; the publish and the `plugin: manifest 0.5.0` PR that follows it are Marty's (that PR's `plugin.json` description should also name `fmrl_list`).

## Tests

`cd packages/mcp && npm ci && npm test && npm run typecheck && npm run build`: 110 tests pass. The sealed-record tests open `test/fixtures/sealed.json`, a byte-for-byte copy of markymd's `internal/crypto/testdata/sealed.json` (Go-sealed; `fmrl.js` opens the same file from markymd's `go test`), and a `node:crypto` opener proves the plugin seals Go's layout. By hand: `scripts/e2e.mjs` against a local markymd `origin/main` (port 8097) — every check ok; and Go's `crypto.OpenRecord` opened a record the plugin sealed.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
```

Run: `gh pr create --draft --base main --head claude/key-durability-plugin --title "…" --body-file <the body above>`

- [ ] **Step 10: Mark ready when CI is green**

Run: `gh pr checks <n> --watch`; when both `mcp (node 20)` and `mcp (node 22)` pass, `gh pr ready <n>`. CodeRabbit reviews once, on ready.

---

## Self-review

**Spec coverage.** §1 the ring: `StoredKey.ring`, minted on first private publish or whoami (Tasks 2, 4; ruling 2 adds a relayed link), `FMRL_RING` (Task 2), `rings[prefix]` for env keys and for a key replaced after a 401 (Task 2), never printed except inside a link (Tasks 2, 4 tests assert it), whoami names the file (Task 4). §2 the record: `sealRecord`/`openRecord`, 200 code points, ≤ 1024 bytes, the fixture mirrored (Task 1; copy per Marty). §7: `preparePrivate` seals and puts `sealed` on the body (Task 4); `#r=` on every `link_url`, `LINK_HINT` gains the ring clause (Task 4); `fmrl_list` with openable and unopenable records (Task 5; ruling 1 for public rows); `fmrl_get` unseals (Task 5); whoami mints and adds the sentence (Task 4); the skill's `fmrl_list` sentence and "never print the ring" (Task 6; ruling 5); `fake-api.ts` serves `GET /docs` and echoes `sealed` (Task 3); vitest covers ring mint, `FMRL_RING`, the fragment on both link surfaces, `fmrl_list` both ways, the fixture (Tasks 1–5). §8: whoami's file sentence (Task 4), README *Keys and limits* and `SKILL.md` one sentence each (Task 6). §9 Node bullet: Task 1 + Task 7 Step 6 (ruling 7). §12 step 3: all. Not here: the manifest bump and `npm publish` (Marty's).

**Placeholders.** None: every code step carries its code, every copy string is verbatim in Global Constraints and in the step that writes it.

**Type consistency.** `isRing`/`newRing`/`sealRecord`/`openRecord`/`OpenedRecord`/`MAX_SEALED_RECORD` (Task 1) are what Tasks 2–5 import. `prefixOf`, `KeyStore.ringFor`/`ringsFor`/`file`/`ringFromEnv`, `KeyStoreOptions.ringFromEnv` (Task 2) are what `index.ts` and `server.ts` use in Tasks 2, 4, 5. `PublishRequest.sealed`, `DocResponse.private`/`.sealed`, `FmrlApi.list` (Task 3) are what `publishAs` (Task 4) and `fmrl_get`/`fmrl_list` (Task 5) call. `FakeDoc.encrypted`/`.sealed`/`.status` (Task 3) are what Task 5's tests set. `withRing(linkUrl, key, ring)` takes the key, not the prefix, everywhere. `PageRow` is a `type` (not an `interface`) so it satisfies `run`'s `Record<string, unknown>` bound. Test helpers `ringInFile`, `RING_PAIR`, `keyOf`, `connect`, `credFile` are introduced in Task 4 and reused in Task 5.
