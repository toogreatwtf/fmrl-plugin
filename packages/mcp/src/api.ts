export interface MintResponse { key: string; prefix: string; created_at: string; quota: { publishes: number; period: string } }
export interface PublishRequest { content: string; format?: "html" | "md"; title?: string }
export interface PublishResponse { id: string; url: string; raw_url: string; manage_url: string; expires_at: string; status: string }
export interface DocResponse { id: string; url: string; status: string; format: string; size: number; expires_at: string | null; pinned: boolean; cid?: string }
export interface MeResponse { prefix: string; created_at: string; quota: { publishes: { used: number; limit: number; resets_at: string } } }

/** ApiError is any non-2xx answer: the contract's code and message, plus resets_at on a 402 and retryAfterSeconds on a 429. A network failure (no response at all) is status 0, code "network". */
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly resetsAt?: string,
    public readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/** FmrlApi is the thin HTTP client for /api/v1. It knows nothing about keys on disk. */
export class FmrlApi {
  private readonly root: string;
  constructor(baseUrl: string, private readonly fetchImpl: typeof fetch = fetch) {
    this.root = baseUrl.replace(/\/+$/, "") + "/api/v1";
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
    return this.call<PublishResponse>("POST", "/publish", key, payload);
  }
  get(key: string, id: string): Promise<DocResponse> {
    return this.call<DocResponse>("GET", `/docs/${encodeURIComponent(id)}`, key);
  }
  async delete(key: string, id: string): Promise<void> {
    await this.call<void>("DELETE", `/docs/${encodeURIComponent(id)}`, key);
  }
  me(key: string): Promise<MeResponse> {
    return this.call<MeResponse>("GET", "/me", key);
  }

  private async call<T>(method: string, path: string, key?: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (key) headers.Authorization = `Bearer ${key}`;
    if (body !== undefined) headers["Content-Type"] = "application/json";
    let res: Response;
    try {
      res = await this.fetchImpl(this.root + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    } catch (e) {
      const cause = (e as { cause?: { message?: string } }).cause?.message ?? (e instanceof Error ? e.message : String(e));
      throw new ApiError(0, "network", `Couldn't reach ${this.root}: ${cause}`);
    }
    const text = await res.text();
    if (res.status === 204) return undefined as T;
    let parsed: unknown;
    try { parsed = text ? JSON.parse(text) : undefined; } catch { parsed = undefined; }
    if (res.ok) return parsed as T;
    const err = (parsed as { error?: { code?: string; message?: string; resets_at?: string } } | undefined)?.error;
    const retryAfterHeader = res.headers.get("retry-after");
    const retryAfterSeconds = retryAfterHeader !== null && /^\d+$/.test(retryAfterHeader) ? parseInt(retryAfterHeader, 10) : undefined;
    throw new ApiError(res.status, err?.code ?? `http_${res.status}`, err?.message ?? `${method} ${path} answered ${res.status}.`, err?.resets_at, retryAfterSeconds);
  }
}
