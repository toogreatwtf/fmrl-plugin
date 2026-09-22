import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createHash, randomBytes } from "node:crypto";

/** FakeEditor and FakeRevision are the fake's in-memory shape of the server's editor and revision wire types. */
export interface FakeEditor { kind: string; key?: string; name?: string }
export interface FakeRevision { rev: number; at: string; size: number; sha256: string; title: string; source: string; format: string; content: string; editor: FakeEditor }

export interface FakeDoc {
  id: string; owner: string; format: string; size: number; title?: string; removed?: boolean; encrypted?: boolean; sealed?: string; status?: string;
  /** rev, revisions and manageToken are absent on a doc a test constructs by hand; the fake treats that as rev 1 with no history and no manage token. */
  rev?: number;
  revisions?: FakeRevision[];
  manageToken?: string;
  /** watchers maps a watching key to the revision it last saw. */
  watchers?: Map<string, number>;
}
export interface RequestLog { method: string; path: string; auth?: string; body?: unknown; manageToken?: string }

export interface FakeApi {
  baseUrl: string;
  keys: Set<string>;
  docs: Map<string, FakeDoc>;
  requests: RequestLog[];
  publishes: Map<string, number>;
  /** linked holds the keys a browser has been linked to: publish stops carrying link_url and me reports linked_at. */
  linked: Set<string>;
  /** labels holds each key's name (from mint's label or a later PATCH /me), "" until set. */
  labels: Map<string, string>;
  quota: number;
  mintLimit: number;
  /** watchLimit is the per-key cap on pages watched at once; a PUT past it answers 409 watch_limit. */
  watchLimit: number;
  close(): Promise<void>;
}

const ID_ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";
function newId(): string {
  const b = randomBytes(12);
  return Array.from(b, (x) => ID_ALPHABET[x % 32]).join("");
}
function newKey(): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const b = randomBytes(32);
  return "fmrl_" + Array.from(b, (x) => alphabet[x % 62]).join("");
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => resolve(data));
  });
}

function json(res: ServerResponse, status: number, body?: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "private, no-store, no-transform");
  res.end(body === undefined ? "" : JSON.stringify(body));
}
function fail(res: ServerResponse, status: number, code: string, message: string, extra: Record<string, unknown> = {}): void {
  json(res, status, { error: { code, message, ...extra } });
}

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
    id: d.id, url: `https://fmrl.test/${d.id}`, status: d.status ?? "live", format: d.format, size: d.size, rev: d.rev ?? 1,
    private: d.encrypted === true,
    ...(d.sealed && d.owner === caller ? { sealed: d.sealed } : {}),
    expires_at: pinned ? null : "2026-09-15T12:00:00Z",
    pinned,
    ...(pinned ? { cid: "bafytest" } : {}),
  };
}

// isoAt is a deterministic timestamp for the nth revision (0-based), so tests never depend on wall clock time.
function isoAt(n: number): string {
  return new Date(Date.UTC(2026, 8, 8, 12, 0, 0) + n * 60000).toISOString();
}

function sha256hex(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

// detectFormat mirrors the server's format detection: an explicit format wins, an encrypted page is always html, otherwise a leading "<" means html.
function detectFormat(content: string, encrypted: boolean, explicit?: string): string {
  if (explicit) return explicit;
  if (encrypted) return "html";
  return content.trimStart().startsWith("<") ? "html" : "md";
}

function editorFor(api: FakeApi, key: string): FakeEditor {
  const name = api.labels.get(key);
  return { kind: "key", key: key.slice(0, 9), ...(name ? { name } : {}) };
}

// watchCount is how many pages this key is currently watching, across every doc.
function watchCount(api: FakeApi, key: string): number {
  let n = 0;
  for (const d of api.docs.values()) if (d.watchers?.has(key)) n++;
  return n;
}

export async function startFakeApi(): Promise<FakeApi> {
  const api: FakeApi = {
    baseUrl: "",
    keys: new Set(),
    docs: new Map(),
    requests: [],
    publishes: new Map(),
    linked: new Set(),
    labels: new Map(),
    quota: 25,
    mintLimit: 5,
    watchLimit: 200,
    close: async () => {},
  };
  let minted = 0;
  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const method = req.method ?? "GET";
    const raw = await readBody(req);
    let body: unknown;
    try { body = raw ? JSON.parse(raw) : undefined; } catch { body = "<unparseable>"; }
    const manageTokenHeader = req.headers["fmrl-manage-token"];
    const manageTokenSent = typeof manageTokenHeader === "string" ? manageTokenHeader : Array.isArray(manageTokenHeader) ? manageTokenHeader[0] : undefined;
    api.requests.push({ method, path: url.pathname, auth: req.headers.authorization, body, manageToken: manageTokenSent });
    const auth = (): string | undefined => {
      const h = req.headers.authorization ?? "";
      const key = h.startsWith("Bearer ") ? h.slice(7).trim() : "";
      return api.keys.has(key) ? key : undefined;
    };
    const unauthorized = () => { res.setHeader("WWW-Authenticate", 'Bearer realm="fmrl"'); fail(res, 401, "invalid_key", "Send a valid key as Authorization: Bearer fmrl_…; mint one with POST /api/v1/keys."); };

    if (method === "POST" && url.pathname === "/api/v1/keys") {
      if (minted >= api.mintLimit) { res.setHeader("Retry-After", "3600"); return fail(res, 429, "rate_limited", "That's a lot of keys from one network. Try again later."); }
      minted++;
      const key = newKey();
      api.keys.add(key);
      const mb = (body ?? {}) as { label?: unknown };
      api.labels.set(key, typeof mb.label === "string" ? mb.label.trim() : "");
      return json(res, 201, { key, prefix: key.slice(0, 9), created_at: "2026-09-08T12:00:00Z", quota: { publishes: api.quota, period: "month" } });
    }
    if (method === "POST" && url.pathname === "/api/v1/publish") {
      const key = auth();
      if (!key) return unauthorized();
      if (raw.length > 3 * 2097152) return fail(res, 413, "too_large", "That's bigger than the 2 MiB limit.");
      const b = (body ?? {}) as { format?: string; content?: string; title?: string; encrypted?: boolean; sealed?: unknown };
      if (b.format !== undefined && b.format !== "html" && b.format !== "md") return fail(res, 400, "bad_request", "format must be html or md, or left out to detect it.");
      if (b.encrypted === true && b.format === "md") return fail(res, 400, "bad_request", "An encrypted page is HTML.");
      if (b.encrypted === true && !String(b.content).startsWith("MARKYENC")) return fail(res, 422, "rejected", "That isn't a valid encrypted page: content must be a MARKYENC v2 envelope.");
      if (b.sealed !== undefined && (b.encrypted !== true || !validSealed(b.sealed))) return fail(res, 400, "bad_request", "sealed must be an unpadded base64url record of at most 1 KiB, and only on an encrypted page.");
      if (!b.content || b.content.trim() === "") return fail(res, 400, "bad_request", "content is required.");
      const used = api.publishes.get(key) ?? 0;
      if (used >= api.quota) return fail(res, 402, "quota_exhausted", "This key has used its free publishes for the month; it resets at 2026-10-01T00:00:00Z.", { resets_at: "2026-10-01T00:00:00Z" });
      if (Buffer.byteLength(b.content) > 2097152) return fail(res, 413, "too_large", "That's bigger than the 2 MiB limit.");
      if (b.content.includes("PHISH")) return fail(res, 422, "rejected", "That can't be shared: it looks like phishing: a well-known brand next to a sign-in prompt.");
      const id = newId();
      const format = detectFormat(b.content, b.encrypted === true, b.format);
      const size = Buffer.byteLength(b.content);
      const initialRevision: FakeRevision = {
        rev: 1, at: isoAt(0), size, sha256: sha256hex(b.content), title: b.title ?? "", source: "api", format, content: b.content,
        editor: editorFor(api, key),
      };
      const manageToken = `tok${id}`;
      api.docs.set(id, {
        id, owner: key, format, size, title: b.title, encrypted: b.encrypted === true, sealed: typeof b.sealed === "string" ? b.sealed : undefined,
        rev: 1, revisions: [initialRevision], manageToken,
      });
      api.publishes.set(key, used + 1);
      // Auto-watch the owner at the revision they just created. Silently
      // skipped over the cap: a publish must never fail because of watch
      // bookkeeping.
      if (watchCount(api, key) < api.watchLimit) {
        api.docs.get(id)!.watchers = new Map([[key, 1]]);
      }
      return json(res, 201, { id, url: `https://fmrl.test/${id}`, raw_url: `https://fmrl.test/${id}/raw`, manage_url: `https://fmrl.test/manage/${id}#k=${manageToken}`, expires_at: "2026-09-15T12:00:00Z", status: "live", link_url: api.linked.has(key) ? undefined : `https://fmrl.test/link/code${id}` });
    }
    const revisionsMatch = url.pathname.match(/^\/api\/v1\/docs\/([^/]+)\/revisions$/);
    if (method === "GET" && revisionsMatch) {
      const key = auth();
      if (!key) return unauthorized();
      const d = api.docs.get(revisionsMatch[1]);
      if (!d || d.removed) return fail(res, 404, "not_found", d ? "That page was removed." : "No page with that id.");
      const revisions = (d.revisions ?? []).map(({ rev, at, size, sha256, title, source, editor }) => ({ rev, at, size, sha256, title, source, editor }));
      const resp: Record<string, unknown> = { rev: d.rev ?? 1, revisions };
      if (d.title === "PINNED") resp.pinned_rev = 1;
      return json(res, 200, resp);
    }
    const revisionMatch = url.pathname.match(/^\/api\/v1\/docs\/([^/]+)\/revisions\/(\d+)$/);
    if (method === "GET" && revisionMatch) {
      const key = auth();
      if (!key) return unauthorized();
      const d = api.docs.get(revisionMatch[1]);
      if (!d || d.removed) return fail(res, 404, "not_found", d ? "That page was removed." : "No page with that id.");
      const n = parseInt(revisionMatch[2], 10);
      const rev = (d.revisions ?? []).find((r) => r.rev === n);
      if (!rev) return fail(res, 404, "not_found", "No such revision of that page.");
      return json(res, 200, rev);
    }
    const watchMatch = url.pathname.match(/^\/api\/v1\/docs\/([^/]+)\/watch$/);
    if (watchMatch && (method === "PUT" || method === "DELETE")) {
      const key = auth();
      if (!key) return unauthorized();
      const d = api.docs.get(watchMatch[1]);
      if (method === "PUT") {
        if (!d || d.removed) return fail(res, 404, "not_found", d ? "That page was removed." : "No page with that id.");
        const alreadyWatching = d.watchers?.has(key) ?? false;
        if (!alreadyWatching && watchCount(api, key) >= api.watchLimit) {
          return fail(res, 409, "watch_limit", "That key is already watching 200 pages; unwatch one first.");
        }
        const wb = (body ?? {}) as { seen_rev?: unknown };
        const currentRev = d.rev ?? 1;
        const seenRev = typeof wb.seen_rev === "number" ? wb.seen_rev : currentRev;
        d.watchers = d.watchers ?? new Map();
        d.watchers.set(key, seenRev);
        return json(res, 200, { id: d.id, url: `https://fmrl.test/${d.id}`, private: d.encrypted === true, rev: currentRev, seen_rev: seenRev });
      }
      // DELETE
      if (!d || !d.watchers?.has(key)) return fail(res, 404, "not_watching", "You aren't watching that page.");
      d.watchers.delete(key);
      res.statusCode = 204; res.setHeader("Cache-Control", "private, no-store, no-transform"); return res.end();
    }
    if (method === "GET" && url.pathname === "/api/v1/docs") {
      const key = auth();
      if (!key) return unauthorized();
      const docs = [...api.docs.values()].filter((d) => d.owner === key && !d.removed).reverse().slice(0, 50).map((d) => docRow(d, key));
      return json(res, 200, { docs });
    }
    const m = url.pathname.match(/^\/api\/v1\/docs\/([^/]+)$/);
    if (m && (method === "GET" || method === "DELETE")) {
      const key = auth();
      if (!key) return unauthorized();
      const d = api.docs.get(m[1]);
      if (method === "GET") {
        if (!d || d.removed) return fail(res, 404, "not_found", d ? "That page was removed." : "No page with that id.");
        return json(res, 200, docRow(d, key));
      }
      if (!d || d.owner !== key) return fail(res, 404, "not_found", "No page with that id.");
      if (d.removed) return fail(res, 404, "not_found", "That page was already removed.");
      d.removed = true;
      res.statusCode = 204; res.setHeader("Cache-Control", "private, no-store, no-transform"); return res.end();
    }
    if (m && method === "PUT") {
      const key = auth();
      if (!key) return unauthorized();
      const d = api.docs.get(m[1]);
      // Owner key, or a matching Fmrl-Manage-Token: anything else gets the
      // same unknown-id 404 a foreign key gets on GET/DELETE, so a probe
      // can't tell "wrong token" from "not yours" from "doesn't exist".
      const owns = !!d && (d.owner === key || (manageTokenSent !== undefined && manageTokenSent === d.manageToken));
      if (!d || !owns) return fail(res, 404, "not_found", "No page with that id.");
      if (d.removed) return fail(res, 404, "not_found", "That page was already removed.");
      const ub = (body ?? {}) as { format?: string; content?: string; title?: string; encrypted?: unknown; base_rev?: unknown };
      if (ub.format !== undefined && ub.format !== "html" && ub.format !== "md") return fail(res, 400, "bad_request", "format must be html or md, or left out to detect it.");
      const wasEncrypted = d.encrypted === true;
      if (ub.encrypted !== undefined && Boolean(ub.encrypted) !== wasEncrypted) {
        return fail(res, 400, "bad_request", "A page's privacy is fixed when it is published: send encrypted the way the page was published.");
      }
      if (wasEncrypted && ub.format === "md") return fail(res, 400, "bad_request", "An encrypted page is HTML.");
      if (!ub.content || String(ub.content).trim() === "") return fail(res, 400, "bad_request", "content is required.");
      if (wasEncrypted && !String(ub.content).startsWith("MARKYENC")) return fail(res, 422, "rejected", "That isn't a valid encrypted page: content must be a MARKYENC v2 envelope.");
      const currentRev = d.rev ?? 1;
      if (ub.base_rev !== undefined && ub.base_rev !== currentRev) {
        return fail(res, 409, "conflict", "Someone edited this page already; re-read it and try again.", { rev: currentRev });
      }
      const format = detectFormat(ub.content, wasEncrypted, ub.format);
      const title = ub.title !== undefined ? String(ub.title) : (d.title ?? "");
      const nextRev = currentRev + 1;
      const size = Buffer.byteLength(ub.content);
      const revision: FakeRevision = {
        rev: nextRev, at: isoAt(nextRev - 1), size, sha256: sha256hex(ub.content), title, source: "api", format, content: ub.content,
        editor: editorFor(api, key),
      };
      d.revisions = d.revisions ?? [];
      d.revisions.push(revision);
      d.rev = nextRev;
      d.format = format;
      d.size = size;
      if (ub.title !== undefined) d.title = ub.title;
      const pinned = d.title === "PINNED";
      return json(res, 200, { id: d.id, url: `https://fmrl.test/${d.id}`, rev: d.rev, expires_at: pinned ? null : "2026-09-15T12:00:00Z", status: d.status ?? "live" });
    }
    if (method === "GET" && url.pathname === "/api/v1/me") {
      if (req.headers["x-fake-hang"] === "1") return; // never respond; test exercises client-side timeout
      const key = auth();
      if (!key) return unauthorized();
      return json(res, 200, { prefix: key.slice(0, 9), created_at: "2026-09-08T12:00:00Z", label: api.labels.get(key) ?? "", quota: { publishes: { used: api.publishes.get(key) ?? 0, limit: api.quota, resets_at: "2026-10-01T00:00:00Z" } }, linked_at: api.linked.has(key) ? "2026-09-16T12:00:00Z" : null, link_url: "https://fmrl.test/link/fresh" });
    }
    if (method === "PATCH" && url.pathname === "/api/v1/me") {
      const key = auth();
      if (!key) return unauthorized();
      const pb = (body ?? {}) as { label?: unknown };
      if (typeof pb.label !== "string") return fail(res, 400, "bad_request", "The body must be a JSON object: {\"label\": \"…\"}.");
      const label = pb.label.trim();
      if ([...label].length > 64) return fail(res, 400, "bad_request", "label must be 64 characters or fewer.");
      api.labels.set(key, label);
      return json(res, 200, { prefix: key.slice(0, 9), created_at: "2026-09-08T12:00:00Z", label, quota: { publishes: { used: api.publishes.get(key) ?? 0, limit: api.quota, resets_at: "2026-10-01T00:00:00Z" } }, linked_at: api.linked.has(key) ? "2026-09-16T12:00:00Z" : null });
    }
    if (method === "GET" && url.pathname === "/api/v1/inbox") {
      const key = auth();
      if (!key) return unauthorized();
      const items: Record<string, unknown>[] = [];
      for (const d of api.docs.values()) {
        if (d.removed) continue;
        const seenRev = d.watchers?.get(key);
        if (seenRev === undefined) continue;
        const rev = d.rev ?? 1;
        if (rev <= seenRev) continue;
        const revisions = (d.revisions ?? [])
          .filter((r) => r.rev > seenRev && r.editor.key !== key.slice(0, 9))
          .map((r) => ({ rev: r.rev, at: r.at, editor: r.editor }));
        if (revisions.length === 0) continue;
        items.push({ id: d.id, url: `https://fmrl.test/${d.id}`, private: d.encrypted === true, status: d.status ?? "live", rev, seen_rev: seenRev, revisions });
      }
      return json(res, 200, { items });
    }
    if (method === "POST" && url.pathname === "/api/v1/inbox/seen") {
      const key = auth();
      if (!key) return unauthorized();
      const sb = (body ?? {}) as { id?: unknown; rev?: unknown };
      const d = typeof sb.id === "string" ? api.docs.get(sb.id) : undefined;
      if (!d || d.watchers?.has(key) !== true) return fail(res, 404, "not_watching", "You aren't watching that page.");
      const currentRev = d.rev ?? 1;
      const seenRev = typeof sb.rev === "number" ? sb.rev : currentRev;
      d.watchers!.set(key, seenRev);
      return json(res, 200, { id: d.id, url: `https://fmrl.test/${d.id}`, private: d.encrypted === true, rev: currentRev, seen_rev: seenRev });
    }
    if (url.pathname.startsWith("/api/v1/")) return fail(res, 404, "not_found", "No such API route.");
    res.statusCode = 404; res.end("not found");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no address");
  api.baseUrl = `http://127.0.0.1:${addr.port}`;
  api.close = () => {
    server.closeAllConnections();
    return new Promise((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  };
  return api;
}
