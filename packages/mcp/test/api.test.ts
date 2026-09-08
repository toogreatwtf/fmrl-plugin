import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApiError, FmrlApi } from "../src/api.js";
import { startFakeApi, type FakeApi } from "./fake-api.js";

let fake: FakeApi;
let api: FmrlApi;
beforeEach(async () => { fake = await startFakeApi(); api = new FmrlApi(fake.baseUrl); });
afterEach(async () => { await fake.close(); });

describe("FmrlApi", () => {
  it("mints, publishes, gets, reports and deletes", async () => {
    const minted = await api.mint("fmrl-mcp");
    expect(minted.key).toMatch(/^fmrl_[A-Za-z0-9]{32}$/);
    expect(fake.requests[0]).toMatchObject({ method: "POST", path: "/api/v1/keys", body: { label: "fmrl-mcp" } });
    const pub = await api.publish(minted.key, { content: "# hi", format: "md", title: "Hi" });
    expect(pub.url).toBe(`https://fmrl.test/${pub.id}`);
    expect(pub.manage_url).toContain("#k=");
    expect(fake.requests[1]).toMatchObject({ auth: `Bearer ${minted.key}`, body: { content: "# hi", format: "md", title: "Hi" } });
    const got = await api.get(minted.key, pub.id);
    expect(got).toMatchObject({ id: pub.id, status: "live", format: "md", pinned: false });
    const me = await api.me(minted.key);
    expect(me.quota.publishes).toEqual({ used: 1, limit: 25, resets_at: "2026-10-01T00:00:00Z" });
    await api.delete(minted.key, pub.id);
    await expect(api.get(minted.key, pub.id)).rejects.toMatchObject({ status: 404, code: "not_found" });
  });
  it("omits format when not given", async () => {
    const { key } = await api.mint("x");
    await api.publish(key, { content: "<h1>x</h1>" });
    expect((fake.requests[1].body as Record<string, unknown>)).not.toHaveProperty("format");
  });
  it("maps every error to ApiError with status, code, message and resets_at", async () => {
    const { key } = await api.mint("x");
    await expect(api.me("fmrl_nope")).rejects.toMatchObject({ status: 401, code: "invalid_key" });
    await expect(api.publish(key, { content: "PHISH" })).rejects.toMatchObject({ status: 422, code: "rejected", message: expect.stringContaining("That can't be shared") });
    fake.quota = 1;
    await api.publish(key, { content: "one" });
    const err = await api.publish(key, { content: "two" }).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 402, code: "quota_exhausted", resetsAt: "2026-10-01T00:00:00Z" });
    await expect(api.publish(key, { content: "x", format: "pdf" as unknown as "md" })).rejects.toMatchObject({ status: 400 });
  });
  it("turns a non-JSON body into an ApiError with the status", async () => {
    const bad = new FmrlApi(fake.baseUrl.replace("/", "/") + "/nope");
    await expect(bad.me("fmrl_x")).rejects.toMatchObject({ status: 404, code: "http_404" });
  });
  it("appends /api/v1 to the base url exactly once", async () => {
    const withSlash = new FmrlApi(fake.baseUrl + "/");
    await withSlash.mint("x");
    expect(fake.requests.at(-1)?.path).toBe("/api/v1/keys");
  });
  it("reports a network failure as an ApiError instead of throwing raw", async () => {
    const unreachable = new FmrlApi("http://127.0.0.1:9");
    const err = await unreachable.mint("x").catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 0, code: "network" });
    expect((err as ApiError).message).toMatch(/^Couldn't reach/);
  });
  it("carries retryAfterSeconds from a 429's Retry-After header", async () => {
    fake.mintLimit = 0;
    await expect(api.mint("x")).rejects.toMatchObject({ status: 429, retryAfterSeconds: 3600 });
  });
  it("times out a request that never answers", async () => {
    const hanging = new FmrlApi(fake.baseUrl, { headers: { "x-fake-hang": "1" }, timeoutMs: 200 });
    const start = Date.now();
    const err = await hanging.me("fmrl_x").catch((e) => e);
    expect(Date.now() - start).toBeLessThan(1000);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 0, code: "timeout" });
    expect((err as ApiError).message).toMatch(/^No answer from .* within 0\.2s\.$/);
  });
});
