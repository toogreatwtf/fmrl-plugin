export interface MintResponse { key: string; prefix: string; created_at: string; quota: { publishes: number; period: string } }
/** sealed is the page's key and title under the key's ring (crypto.sealRecord); the server takes it on an encrypted page only. */
export interface PublishRequest { content: string; format?: "html" | "md"; title?: string; encrypted?: boolean; sealed?: string }
/** link_url rides on a publish only until a browser has been linked to the key; a server that predates linking never sends it. */
export interface PublishResponse { id: string; url: string; raw_url: string; manage_url: string; expires_at: string; status: string; link_url?: string }
/**
 * DocResponse is a page as GET /api/v1/docs/{id} and each GET /api/v1/docs row
 * describe it. rev and private come from servers with sealed records
 * (markymd #71); sealed is present only on a private page that has one, and
 * only to the key that owns the page.
 */
export interface DocResponse { id: string; url: string; status: string; format: string; size: number; expires_at: string | null; pinned: boolean; cid?: string; rev?: number; private?: boolean; sealed?: string }
/** DocsResponse is GET /api/v1/docs: this key's pages, newest first, 50 at most, removed and expired left out. */
export interface DocsResponse { docs: DocResponse[] }
/** linked_at is when a browser first redeemed a link for this key; link_url is a fresh link every call. Both are absent from a server that predates linking. */
export interface MeResponse { prefix: string; created_at: string; label: string; quota: { publishes: { used: number; limit: number; resets_at: string } }; linked_at?: string | null; link_url?: string }

/** Editor describes who made a revision. "manage" never happens through the API: an edit made with a manage token still carries the caller's own key. */
export interface Editor { kind: "key" | "session" | "manage" | "anonymous" | "unknown"; key?: string; name?: string }
/** RevisionContent is one revision's full body, as stored: Markdown, HTML, or a private page's envelope. */
export interface RevisionContent { rev: number; at: string; size: number; sha256: string; title: string; source: string; format: "html" | "md"; content: string; editor: Editor }
/** RevisionMeta is one row of a page's revision list, without the body. */
export interface RevisionMeta { rev: number; at: string; size: number; sha256: string; title: string; source: string; editor: Editor }
/** UpdateResponse mirrors the server's updateResponse (internal/handler/api_revisions.go). */
export interface UpdateResponse { id: string; url: string; rev: number; expires_at: string | null; status: string }
/** WatchResponse is what watching, unwatching's sibling PUT, and marking an inbox item seen all answer with. */
export interface WatchResponse { id: string; url: string; private: boolean; rev: number; seen_rev: number }
/** InboxItem is one page with unread revisions: only revisions made by a key other than the watcher's own. */
export interface InboxItem { id: string; url: string; private: boolean; status: string; rev: number; seen_rev: number; revisions: { rev: number; at: string; editor: Editor }[] }

/** ApiError is any non-2xx answer: the contract's code and message, plus resets_at on a 402, retryAfterSeconds on a 429, and rev on a 409 conflict. A network failure (no response at all) is status 0, code "network". */
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly resetsAt?: string,
    public readonly retryAfterSeconds?: number,
    public readonly rev?: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/** FmrlApi is the thin HTTP client for /api/v1. It knows nothing about keys on disk. */
export class FmrlApi {
  private readonly root: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly extraHeaders: Record<string, string>;
  constructor(baseUrl: string, opts: { fetchImpl?: typeof fetch; timeoutMs?: number; headers?: Record<string, string> } = {}) {
    this.root = baseUrl.replace(/\/+$/, "") + "/api/v1";
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 30000;
    this.extraHeaders = opts.headers ?? {};
  }

  /** viewerBase is the host pages live on: the configured base URL without /api/v1. */
  get viewerBase(): string {
    return this.root.slice(0, -"/api/v1".length);
  }

  mint(label: string): Promise<MintResponse> {
    return this.call<MintResponse>("POST", "/keys", undefined, { label });
  }
  publish(key: string, body: PublishRequest): Promise<PublishResponse> {
    const payload: Record<string, unknown> = { content: body.content };
    if (body.format !== undefined) payload.format = body.format;
    if (body.title !== undefined) payload.title = body.title;
    if (body.encrypted) payload.encrypted = true;
    if (body.sealed !== undefined) payload.sealed = body.sealed;
    return this.call<PublishResponse>("POST", "/publish", key, payload);
  }
  get(key: string, id: string): Promise<DocResponse> {
    return this.call<DocResponse>("GET", `/docs/${encodeURIComponent(id)}`, key);
  }
  list(key: string): Promise<DocsResponse> {
    return this.call<DocsResponse>("GET", "/docs", key);
  }
  async delete(key: string, id: string): Promise<void> {
    await this.call<void>("DELETE", `/docs/${encodeURIComponent(id)}`, key);
  }
  me(key: string): Promise<MeResponse> {
    return this.call<MeResponse>("GET", "/me", key);
  }
  setLabel(key: string, label: string): Promise<MeResponse> {
    return this.call<MeResponse>("PATCH", "/me", key, { label });
  }
  getRevision(key: string, id: string, rev: number): Promise<RevisionContent> {
    return this.call<RevisionContent>("GET", `/docs/${encodeURIComponent(id)}/revisions/${rev}`, key);
  }
  revisions(key: string, id: string): Promise<{ rev: number; pinned_rev?: number; revisions: RevisionMeta[] }> {
    return this.call<{ rev: number; pinned_rev?: number; revisions: RevisionMeta[] }>("GET", `/docs/${encodeURIComponent(id)}/revisions`, key);
  }
  /** update replaces a page's content. manageToken, when given, rides as Fmrl-Manage-Token so a caller who isn't the owning key can still edit a page it holds the manage link for. */
  update(
    key: string,
    id: string,
    body: { content: string; format?: "html" | "md"; title?: string; encrypted?: boolean; base_rev?: number },
    manageToken?: string,
  ): Promise<UpdateResponse> {
    const payload: Record<string, unknown> = { content: body.content };
    if (body.format !== undefined) payload.format = body.format;
    if (body.title !== undefined) payload.title = body.title;
    if (body.encrypted !== undefined) payload.encrypted = body.encrypted;
    if (body.base_rev !== undefined) payload.base_rev = body.base_rev;
    const extraHeaders = manageToken !== undefined ? { "Fmrl-Manage-Token": manageToken } : undefined;
    return this.call<UpdateResponse>("PUT", `/docs/${encodeURIComponent(id)}`, key, payload, extraHeaders);
  }
  watch(key: string, id: string, seenRev?: number): Promise<WatchResponse> {
    const body = seenRev !== undefined ? { seen_rev: seenRev } : undefined;
    return this.call<WatchResponse>("PUT", `/docs/${encodeURIComponent(id)}/watch`, key, body);
  }
  async unwatch(key: string, id: string): Promise<void> {
    await this.call<void>("DELETE", `/docs/${encodeURIComponent(id)}/watch`, key);
  }
  inbox(key: string): Promise<{ items: InboxItem[] }> {
    return this.call<{ items: InboxItem[] }>("GET", "/inbox", key);
  }
  inboxSeen(key: string, id: string, rev: number): Promise<WatchResponse> {
    return this.call<WatchResponse>("POST", "/inbox/seen", key, { id, rev });
  }

  private async call<T>(method: string, path: string, key?: string, body?: unknown, extraHeaders?: Record<string, string>): Promise<T> {
    const headers: Record<string, string> = { Accept: "application/json", ...this.extraHeaders, ...extraHeaders };
    if (key) headers.Authorization = `Bearer ${key}`;
    if (body !== undefined) headers["Content-Type"] = "application/json";
    let res: Response;
    try {
      res = await this.fetchImpl(this.root + path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) {
      if (e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError")) {
        throw new ApiError(0, "timeout", `No answer from ${this.root} within ${this.timeoutMs / 1000}s.`);
      }
      const cause = (e as { cause?: { message?: string } }).cause?.message ?? (e instanceof Error ? e.message : String(e));
      throw new ApiError(0, "network", `Couldn't reach ${this.root}: ${cause}`);
    }
    const text = await res.text();
    if (res.status === 204) return undefined as T;
    let parsed: unknown;
    try { parsed = text ? JSON.parse(text) : undefined; } catch { parsed = undefined; }
    if (res.ok) return parsed as T;
    const err = (parsed as { error?: { code?: string; message?: string; resets_at?: string; rev?: number } } | undefined)?.error;
    const retryAfterHeader = res.headers.get("retry-after");
    const retryAfterSeconds = retryAfterHeader !== null && /^\d+$/.test(retryAfterHeader) ? parseInt(retryAfterHeader, 10) : undefined;
    throw new ApiError(res.status, err?.code ?? `http_${res.status}`, err?.message ?? `${method} ${path} answered ${res.status}.`, err?.resets_at, retryAfterSeconds, err?.rev);
  }
}
