# Canvas collaboration cut 1 (plugin) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give any MCP client what the loop needs: read a page you were handed (and decrypt it locally), edit a page you hold the manage link for, watch a page, sweep an inbox, and carry a name.

**Architecture:** `FmrlApi` gains the new and newly-used routes. A local page store (`pages.json` beside `credentials.json`, 0600 in a 0700 dir) remembers page keys and manage tokens per base URL and page id. `fmrl_get` reads revision content and opens private envelopes locally; new tools `fmrl_edit`, `fmrl_watch`, `fmrl_inbox`; the key's name is set once per process from `FMRL_AGENT_NAME` or the MCP client's name. The share skill documents the sweep.

**Tech Stack:** TypeScript, `@modelcontextprotocol/sdk` ^1.30, zod, vitest with the local `test/fake-api.ts` HTTP server, WebCrypto.

**Spec:** markymd `docs/superpowers/specs/2026-09-21-fmrl-canvas-collaboration-design.md` (Cut 1). Server half: markymd `docs/superpowers/plans/2026-09-21-fmrl-canvas-collab-cut1-server.md`, which defines the wire shapes below.

## Global Constraints

- A page key never leaves this machine: never sent to the server, never logged, never in an error message. The store file is 0600 in a 0700 directory, written atomically (temp + rename) and moved aside, never overwritten, when unreadable — the same care as `credentials.ts`.
- A key from a URL fragment is remembered only after it opens the page's envelope (a crafted `#p=` never lands in the store).
- The name comes from `FMRL_AGENT_NAME`, or else the MCP client's own `clientInfo.name` from `initialize`, and never from the hostname. The client's name only fills an empty label; `FMRL_AGENT_NAME` replaces a different one. Setting it never fails a tool call.
- Wire shapes (server plan): `GET /api/v1/me` → `{prefix, label, created_at, quota, linked_at, link_url?}`; `PATCH /api/v1/me` `{label}` → same minus `link_url`; `GET /api/v1/docs/{id}/revisions/{rev}` → `{rev, at, size, sha256, title, source, format, content, editor: {kind, key?, name?}}`; `GET …/revisions` → `{rev, pinned_rev?, revisions: [{rev, at, size, sha256, title, source, editor}]}`; `PUT /api/v1/docs/{id}` body `{content, format?, title?, encrypted?, base_rev?}` with optional header `Fmrl-Manage-Token`, 409 `conflict` carries `error.rev`; `PUT /api/v1/docs/{id}/watch` body `{seen_rev?}` → `{id, url, private, rev, seen_rev}`; `DELETE …/watch` → 204; `GET /api/v1/inbox` → `{items: [{id, url, private, status, rev, seen_rev, revisions: [{rev, at, editor}]}]}`; `POST /api/v1/inbox/seen` `{id, rev}` → watch shape. Errors add `404 not_watching`, `409 watch_limit`.
- Fragments: a page link is `/{id}#p=<43 base64url>`; a manage link is `/manage/{id}#k=<22 chars>`; a combined fragment may carry both, `&`-separated. Tools accept any of these, or a bare id.
- Versions move together: `packages/mcp/package.json` 0.5.0 → 0.6.0, `plugins/fmrl/.claude-plugin/plugin.json` → 0.6.0 (its description lists every tool). Both READMEs list every tool.
- Commits end with `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>` — this exact line, whatever model your harness names.
- Tests: `cd packages/mcp && npm test && npm run typecheck && npm run build`.

---

### Task 1: API client methods and the fake server

**Files:** Modify `packages/mcp/src/api.ts`, `packages/mcp/test/fake-api.ts`; Test `packages/mcp/test/api.test.ts`

**Interfaces — Produces** (all through the existing private `call<T>`; types exported):
```ts
export interface Editor { kind: "key" | "session" | "manage" | "anonymous" | "unknown"; key?: string; name?: string }
export interface RevisionContent { rev: number; at: string; size: number; sha256: string; title: string; source: string; format: "html" | "md"; content: string; editor: Editor }
export interface RevisionMeta { rev: number; at: string; size: number; sha256: string; title: string; source: string; editor: Editor }
export interface WatchResponse { id: string; url: string; private: boolean; rev: number; seen_rev: number }
export interface InboxItem { id: string; url: string; private: boolean; status: string; rev: number; seen_rev: number; revisions: { rev: number; at: string; editor: Editor }[] }
// FmrlApi additions
getRevision(key: string, id: string, rev: number): Promise<RevisionContent>
revisions(key: string, id: string): Promise<{ rev: number; pinned_rev?: number; revisions: RevisionMeta[] }>
update(key: string, id: string, body: { content: string; format?: "html" | "md"; title?: string; encrypted?: boolean; base_rev?: number }, manageToken?: string): Promise<UpdateResponse>
setLabel(key: string, label: string): Promise<MeResponse>
watch(key: string, id: string, seenRev?: number): Promise<WatchResponse>
unwatch(key: string, id: string): Promise<void>
inbox(key: string): Promise<{ items: InboxItem[] }>
inboxSeen(key: string, id: string, rev: number): Promise<WatchResponse>
```
`MeResponse` gains `label: string`. `UpdateResponse` mirrors the server's (`id`, `url`, `rev`, … — read `internal/handler/api_revisions.go` `updateResponse` in markymd for the field list). `call` must accept extra headers (for `Fmrl-Manage-Token`) and a 204 (no body).

The fake server grows a faithful subset: per-doc revision list with editors (the calling key's prefix and label, `manage` never happens through the API), `GET` revision content, `PUT /docs/{id}` accepting the owner key or a matching `Fmrl-Manage-Token` (the fake mints a manage token on publish and returns it the way the real publish response does — check markymd `publishResponse` for its field), base_rev conflict → 409 with `error.rev`, `PATCH /me` with the 64-rune rule, watches (auto-watch on publish at rev 1, 200 cap → 409 `watch_limit`), inbox derivation (revisions after seen by other keys), seen-on-read, `POST /inbox/seen`.

- [ ] **Step 1:** Failing tests in `api.test.ts` for each method against the fake (happy path, 409 conflict carries the rev in `ApiError`, the manage-token header is sent only when given, 204 unwatch resolves).
- [ ] **Step 2:** `npm test` → FAIL. **Step 3:** Implement. **Step 4:** `npm test && npm run typecheck` → PASS.
- [ ] **Step 5:** Commit `api: revisions, edit with a manage token, name, watch and inbox`.

---

### Task 2: Page references and the local page store

**Files:** Modify `packages/mcp/src/ids.ts`, `packages/mcp/src/credentials.ts` (export the dir/permission helpers if needed); Create `packages/mcp/src/pages.ts`; Test `packages/mcp/test/ids.test.ts`, `packages/mcp/test/pages.test.ts`

**Interfaces — Produces:**
```ts
// ids.ts
export interface PageRef { id: string; key?: string; manage?: string }
// Accepts a bare id, any fmrl URL (/{id}, /{id}/rev/3, /manage/{id}, /edit/{id}), with or
// without a fragment carrying p=<43 base64url> and/or k=<manage token>, &-separated.
// A malformed p or k is dropped, not an error.
export function parsePageRef(input: string): PageRef
// pages.ts
export interface PageSecrets { key?: string; manage?: string }
export function pagesPath(env?: NodeJS.ProcessEnv, platform?: NodeJS.Platform): string // beside credentials.json: <dir>/pages.json
export class PageStore {
  constructor(baseUrl: string, path?: string)
  get(id: string): Promise<PageSecrets>
  remember(id: string, s: PageSecrets): Promise<void> // merges; undefined fields leave what is stored
}
```
File shape: `{"version": 1, "pages": {"<baseUrl>": {"<id>": {"key": "...", "manage": "..."}}}}`. Writes serialized through one promise chain (as `KeyStore.fileQueue`); 0700 dir, 0600 file, temp+rename; an unparseable or wrong-version file is moved aside with the same helper `credentials.ts` uses, and the store starts empty.

- [ ] **Step 1:** Failing tests: every URL shape above, fragments in either order, malformed parts dropped; store round-trip, merge, per-base-URL isolation, file and dir modes (skip mode checks on win32), a corrupt file moved aside with its bytes intact.
- [ ] **Step 2–4:** FAIL → implement → PASS (`npm test && npm run typecheck`).
- [ ] **Step 5:** Commit `pages: parse page links, and remember page keys and manage tokens locally`.

---

### Task 3: `fmrl_get` reads the page

**Files:** Modify `packages/mcp/src/server.ts` (the `fmrl_get` registration ~l.322, `ServerDeps` gains `pages: PageStore`), `packages/mcp/src/index.ts` (construct the `PageStore`), `packages/mcp/src/crypto.ts` (drop the "used by tests" note on `openEnvelope`); Test `packages/mcp/test/server.test.ts`

**Behaviour:** input `{ id: string (id or link, may carry #p= / #k=), rev?: number (int ≥ 1) }`.
1. `parsePageRef`; `api.get` for metadata; `rev = input.rev ?? d.rev`.
2. `api.getRevision(k, id, rev)`. (The server marks the revision seen when this key watches the page.)
3. Public page: `content` is the stored source (Markdown or HTML), `content_format` its format.
4. Private page: find a key — the fragment's, else `pages.get(id).key`, else this key's own ring through the sealed record (the current `unseal` path). Try each until `openEnvelope` succeeds. On success, remember a fragment key (and a fragment manage token) in the page store. The decrypted document is HTML; when it contains `<script type="text/x-fmrl-source" data-format="md">…</script>`, return that source, entity-unescaped (`&lt;` → `<`, `&amp;` → `&`), as `content` with `content_format: "md"`, otherwise the HTML with `"html"`. No key opens it → metadata only, with `content_note: "private: pass the link with #p=<key> to read it"`.
5. Output adds `rev`, `latest_rev`, `editor`, `content?`, `content_format?`, `content_note?` to today's page row; the text rendering prints the metadata line then the content.
Description: "Read a page by id or link: its metadata and, for revision `rev` (default the latest), its content. A private page opens here with the key after #p= in the link you were handed, or one this machine already holds; the key never leaves this machine. Reading a revision of a page you watch marks it seen."

- [ ] **Step 1:** Failing tests: public md read; older `rev`; private page opened by a fragment key and the key then remembered; opened by a stored key; opened by the owner's ring; a wrong fragment key is not remembered and yields metadata + note; the source block is extracted and unescaped; an html private page returns html.
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5:** Commit `fmrl_get: read a revision's content, and open a private page with the key you were handed`.

---

### Task 4: `fmrl_edit`

**Files:** Modify `packages/mcp/src/server.ts`; Test `packages/mcp/test/server.test.ts`

**Behaviour:** input `{ id: string (link or id; #p= and #k= honoured), content: string (≤ 2 MiB), format?: "html" | "md", title?: string, base_rev?: number }`.
1. `parsePageRef`; merge fragment secrets with `pages.get(id)`; `api.get` for metadata (this also says `private`).
2. Private: a page key is required (fragment/store/ring as in Task 3, verified by opening the current revision); none → fail "This page is private: pass its link with #p=<key>." Render and seal exactly as `fmrl_publish`'s private path does (Markdown → HTML via `markdown.ts`, with the same `text/x-fmrl-source` block if publish embeds one; the same `wrapDocument`) but **under the existing key** — `crypto.ts` gains `sealWithKey(html, key)` (refactor `seal` to call it). Send `encrypted: true`, `format: "html"`. Never send `sealed` (the server keeps the owner's record; only the owner may replace it).
3. Proof: when this key is not the page's owner, send `Fmrl-Manage-Token` from the fragment or store; without one, the server's 404 becomes "You can edit this page with its manage link (…/manage/{id}#k=…); pass it as id once and it is remembered."
4. `api.update(k, id, body, manage)`. A 409 conflict → fail "Revision N is the latest; read it with fmrl_get and edit from there." with `latest_rev: N`.
5. On success remember any fragment secrets; return `{id, url (with #p= for a private page), rev}`.
Description: "Replace a page's content with a new revision. Pass base_rev (the rev you read) so an edit made meanwhile is not overwritten. Works on your own pages and on any page whose manage link you were given; a private page stays private under its same key, so every existing link keeps opening it."
Publishing also remembers: after a private `fmrl_publish`, store its key and manage token; after a public one, its manage token.

- [ ] **Step 1:** Failing tests: owner edits a public page; a second key edits with a manage link passed once, then again by bare id (remembered); private edit re-seals under the same key (the original link opens rev 2 via `fmrl_get`); no key on a private page fails with the sentence; conflict message; `sealed` never sent (assert on `fake.requests`); publish remembers secrets.
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5:** Commit `fmrl_edit: revise a page you own or hold the manage link for, private pages under their same key`.

---

### Task 5: `fmrl_watch`, `fmrl_inbox`, and the name

**Files:** Modify `packages/mcp/src/server.ts`, `packages/mcp/src/config.ts` (`agentName?: string` from `FMRL_AGENT_NAME`: trimmed, ≤ 64 code points, no control characters, else ignored with one stderr warning that does not echo it), `packages/mcp/src/index.ts`; Test `packages/mcp/test/server.test.ts`, `packages/mcp/test/config.test.ts`

**Behaviour:**
- `fmrl_watch` `{ id: string (link; #p=/#k= remembered after the key opens the page — reuse Task 3's opener), seen_rev?: number (int ≥ 0) }` → `api.watch` → `{id, url, private, rev, seen_rev, can_open}`. Description: "Watch a page so revisions other editors make show up in fmrl_inbox. Pass the link you were handed; its key stays on this machine. Pages you publish are watched already."
- `fmrl_inbox` `{}` → `api.inbox` → items plus `can_open` (public, or a key in the page store). Text rendering: one line per page — id, status, `rev N by NAME` for each new revision (NAME: `name`, else `key`, else the kind), and "read with fmrl_get <url> rev N". Description: "Pages you watch that someone else has revised since you last read them, newest first. Read each with fmrl_get (which marks it seen). A page that was removed or expired appears once."
- The name: `createServer` gets `agentName?: string`. Before the first tool call's API work (inside `run`, once per process, awaited but never failing the call), `ensureName(k)`: `me = api.me(k)`; `want = agentName ?? (me.label ? undefined : server.server.getClientVersion()?.name)`; when `want` and `want !== me.label`, `api.setLabel(k, want)`. Failures log one line to stderr. `fmrl_whoami` output gains `label`.
- Tools list assertion becomes the nine names: `fmrl_delete, fmrl_edit, fmrl_get, fmrl_inbox, fmrl_list, fmrl_publish, fmrl_publish_file, fmrl_watch, fmrl_whoami`.

- [ ] **Step 1:** Failing tests: watch with a fragment link remembers the key and returns `can_open`; inbox lists another key's revision with its name and `can_open`; after `fmrl_get` of that rev the inbox is empty; `FMRL_AGENT_NAME` sets the label on first call and replaces a different one; the client name (connect the test `Client` as `{name: "claude-code"}`) fills an empty label and does not replace an existing one; a failing `setLabel` does not fail the tool; config validation cases.
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5:** Commit `fmrl_watch and fmrl_inbox; the key carries a name`.

---

### Task 6: Docs, the sweep, versions

**Files:** Modify `README.md`, `packages/mcp/README.md` (tool tables: nine tools, `fmrl_get`'s new reading, `FMRL_AGENT_NAME` in the environment table, the page store file and what it holds), `plugins/fmrl/skills/share/SKILL.md`, `plugins/fmrl/.claude-plugin/plugin.json` (0.6.0; description names every tool), `packages/mcp/package.json` (0.6.0), `packages/mcp/package-lock.json` (version field), `packages/mcp/scripts/e2e.mjs` (extend: name the key, publish private, a second key watches through the link + manage link, edits, the first key's inbox shows it; keep `redact()` on every printed link)

The share skill gains two short sections after *Steps*:
- **Reading a page you were handed** — call `fmrl_get` with the whole link (the part after `#` included); for a page you will keep working on, `fmrl_watch` it.
- **The sweep** — a copyable prompt:
  > Sweep fmrl: call fmrl_inbox. For each page listed, call fmrl_get with its link and the newest revision, and do what it asks of you — edit with fmrl_edit, passing base_rev as the revision you read. If nothing is new, wait and sweep again. When the next move is your person's, tell them the way your harness can.
The *Never* list gains: never paste a page key or manage token into a page, a log, or a message to anyone other than the person who asked.

- [ ] **Step 1:** Write the docs; bump versions (`npm version 0.6.0 --no-git-tag-version` in `packages/mcp`).
- [ ] **Step 2:** `npm test && npm run typecheck && npm run build` → PASS. Against a local markymd server on the server branch (`FMRL_API_URL=http://localhost:8181 node scripts/e2e.mjs`) → PASS.
- [ ] **Step 3:** Commit `docs: nine tools, the sweep; 0.6.0`.
