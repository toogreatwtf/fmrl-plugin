import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";

export interface FakeDoc { id: string; owner: string; format: string; size: number; title?: string; removed?: boolean }
export interface RequestLog { method: string; path: string; auth?: string; body?: unknown }

export interface FakeApi {
  baseUrl: string;
  keys: Set<string>;
  docs: Map<string, FakeDoc>;
  requests: RequestLog[];
  publishes: Map<string, number>;
  /** linked holds the keys a browser has been linked to: publish stops carrying link_url and me reports linked_at. */
  linked: Set<string>;
  quota: number;
  mintLimit: number;
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

export async function startFakeApi(): Promise<FakeApi> {
  const api: FakeApi = {
    baseUrl: "",
    keys: new Set(),
    docs: new Map(),
    requests: [],
    publishes: new Map(),
    linked: new Set(),
    quota: 25,
    mintLimit: 5,
    close: async () => {},
  };
  let minted = 0;
  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const method = req.method ?? "GET";
    const raw = await readBody(req);
    let body: unknown;
    try { body = raw ? JSON.parse(raw) : undefined; } catch { body = "<unparseable>"; }
    api.requests.push({ method, path: url.pathname, auth: req.headers.authorization, body });
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
      return json(res, 201, { key, prefix: key.slice(0, 9), created_at: "2026-09-08T12:00:00Z", quota: { publishes: api.quota, period: "month" } });
    }
    if (method === "POST" && url.pathname === "/api/v1/publish") {
      const key = auth();
      if (!key) return unauthorized();
      if (raw.length > 3 * 2097152) return fail(res, 413, "too_large", "That's bigger than the 2 MiB limit.");
      const b = (body ?? {}) as { format?: string; content?: string; title?: string; encrypted?: boolean };
      if (b.format !== undefined && b.format !== "html" && b.format !== "md") return fail(res, 400, "bad_request", "format must be html or md, or left out to detect it.");
      if (b.encrypted === true && b.format === "md") return fail(res, 400, "bad_request", "An encrypted page is HTML.");
      if (b.encrypted === true && !String(b.content).startsWith("MARKYENC")) return fail(res, 422, "rejected", "That isn't a valid encrypted page: content must be a MARKYENC v2 envelope.");
      if (!b.content || b.content.trim() === "") return fail(res, 400, "bad_request", "content is required.");
      const used = api.publishes.get(key) ?? 0;
      if (used >= api.quota) return fail(res, 402, "quota_exhausted", "This key has used its free publishes for the month; it resets at 2026-10-01T00:00:00Z.", { resets_at: "2026-10-01T00:00:00Z" });
      if (Buffer.byteLength(b.content) > 2097152) return fail(res, 413, "too_large", "That's bigger than the 2 MiB limit.");
      if (b.content.includes("PHISH")) return fail(res, 422, "rejected", "That can't be shared: it looks like phishing: a well-known brand next to a sign-in prompt.");
      const id = newId();
      const format = b.format ?? (b.encrypted === true ? "html" : (b.content.trimStart().startsWith("<") ? "html" : "md"));
      api.docs.set(id, { id, owner: key, format, size: Buffer.byteLength(b.content), title: b.title });
      api.publishes.set(key, used + 1);
      return json(res, 201, { id, url: `https://fmrl.test/${id}`, raw_url: `https://fmrl.test/${id}/raw`, manage_url: `https://fmrl.test/manage/${id}#k=tok${id}`, expires_at: "2026-09-15T12:00:00Z", status: "live", link_url: api.linked.has(key) ? undefined : `https://fmrl.test/link/code${id}` });
    }
    const m = url.pathname.match(/^\/api\/v1\/docs\/([^/]+)$/);
    if (m && (method === "GET" || method === "DELETE")) {
      const key = auth();
      if (!key) return unauthorized();
      const d = api.docs.get(m[1]);
      if (method === "GET") {
        if (!d || d.removed) return fail(res, 404, "not_found", d ? "That page was removed." : "No page with that id.");
        const pinned = d.title === "PINNED";
        return json(res, 200, {
          id: d.id, url: `https://fmrl.test/${d.id}`, status: "live", format: d.format, size: d.size,
          expires_at: pinned ? null : "2026-09-15T12:00:00Z",
          pinned,
          ...(pinned ? { cid: "bafytest" } : {}),
        });
      }
      if (!d || d.owner !== key) return fail(res, 404, "not_found", "No page with that id.");
      if (d.removed) return fail(res, 404, "not_found", "That page was already removed.");
      d.removed = true;
      res.statusCode = 204; res.setHeader("Cache-Control", "private, no-store, no-transform"); return res.end();
    }
    if (method === "GET" && url.pathname === "/api/v1/me") {
      if (req.headers["x-fake-hang"] === "1") return; // never respond; test exercises client-side timeout
      const key = auth();
      if (!key) return unauthorized();
      return json(res, 200, { prefix: key.slice(0, 9), created_at: "2026-09-08T12:00:00Z", quota: { publishes: { used: api.publishes.get(key) ?? 0, limit: api.quota, resets_at: "2026-10-01T00:00:00Z" } }, linked_at: api.linked.has(key) ? "2026-09-16T12:00:00Z" : null, link_url: "https://fmrl.test/link/fresh" });
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
