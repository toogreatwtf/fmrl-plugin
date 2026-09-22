import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApiError, FmrlApi } from "../src/api.js";
import { startFakeApi, type FakeApi } from "./fake-api.js";
import { newRing, sealRecord } from "../src/crypto.js";

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

  describe("revisions", () => {
    it("lists the initial revision after publish and reads its content", async () => {
      const { key } = await api.mint("x");
      const pub = await api.publish(key, { content: "# hi", format: "md", title: "Hi" });
      const list = await api.revisions(key, pub.id);
      expect(list.rev).toBe(1);
      expect(list.pinned_rev).toBeUndefined();
      expect(list.revisions).toHaveLength(1);
      expect(list.revisions[0]).toMatchObject({ rev: 1, title: "Hi", source: "api", editor: { kind: "key" } });
      expect(list.revisions[0].editor.key).toBe(key.slice(0, 9));
      const rev = await api.getRevision(key, pub.id, 1);
      expect(rev).toMatchObject({ rev: 1, format: "md", content: "# hi", title: "Hi" });
    });
    it("404s a revision that doesn't exist", async () => {
      const { key } = await api.mint("x");
      const pub = await api.publish(key, { content: "# hi" });
      await expect(api.getRevision(key, pub.id, 9)).rejects.toMatchObject({ status: 404, code: "not_found" });
    });
  });

  describe("update", () => {
    it("edits as the owner and grows the revision list", async () => {
      const { key } = await api.mint("x");
      const pub = await api.publish(key, { content: "# hi", format: "md" });
      const updated = await api.update(key, pub.id, { content: "# bye", format: "md" });
      expect(updated).toMatchObject({ id: pub.id, rev: 2, status: "live" });
      const list = await api.revisions(key, pub.id);
      expect(list.rev).toBe(2);
      expect(list.revisions.map((r) => r.rev)).toEqual([1, 2]);
      expect((await api.getRevision(key, pub.id, 2)).content).toBe("# bye");
    });
    it("sends the manage-token header only when given", async () => {
      const { key } = await api.mint("x");
      const pub = await api.publish(key, { content: "# hi", format: "md" });
      await api.update(key, pub.id, { content: "# bye", format: "md" });
      expect(fake.requests.at(-1)?.manageToken).toBeUndefined();
      const manageToken = pub.manage_url.split("#k=")[1];
      const stranger = await api.mint("y");
      await api.update(stranger.key, pub.id, { content: "# again", format: "md" }, manageToken);
      expect(fake.requests.at(-1)?.manageToken).toBe(manageToken);
    });
    it("lets a foreign key edit with the right manage token, and refuses without one", async () => {
      const { key } = await api.mint("x");
      const pub = await api.publish(key, { content: "# hi", format: "md" });
      const stranger = await api.mint("y");
      await expect(api.update(stranger.key, pub.id, { content: "# nope", format: "md" })).rejects.toMatchObject({ status: 404, code: "not_found" });
      const manageToken = pub.manage_url.split("#k=")[1];
      const updated = await api.update(stranger.key, pub.id, { content: "# yes", format: "md" }, manageToken);
      expect(updated.rev).toBe(2);
      await expect(api.update(stranger.key, pub.id, { content: "# wrong token" }, "wrong")).rejects.toMatchObject({ status: 404, code: "not_found" });
    });
    it("409s a stale base_rev and carries the current rev in the ApiError", async () => {
      const { key } = await api.mint("x");
      const pub = await api.publish(key, { content: "# hi", format: "md" });
      await api.update(key, pub.id, { content: "# bye", format: "md", base_rev: 1 });
      const err = await api.update(key, pub.id, { content: "# stale", format: "md", base_rev: 1 }).catch((e) => e);
      expect(err).toBeInstanceOf(ApiError);
      expect(err).toMatchObject({ status: 409, code: "conflict", rev: 2 });
    });
  });

  describe("label", () => {
    it("sets a name that shows up on me() and on later edits", async () => {
      const { key } = await api.mint("x");
      const me1 = await api.setLabel(key, "Aria");
      expect(me1.label).toBe("Aria");
      expect(await (await api.me(key)).label).toBe("Aria");
      const pub = await api.publish(key, { content: "# hi", format: "md" });
      const list = await api.revisions(key, pub.id);
      expect(list.revisions[0].editor.name).toBe("Aria");
    });
    it("rejects a label over 64 runes", async () => {
      const { key } = await api.mint("x");
      await expect(api.setLabel(key, "x".repeat(65))).rejects.toMatchObject({ status: 400, code: "bad_request" });
    });
  });

  describe("watch and inbox", () => {
    it("watches, sees a stranger's edit in the inbox, marks it seen, and unwatches", async () => {
      const owner = await api.mint("owner");
      const editor = await api.mint("editor");
      const pub = await api.publish(owner.key, { content: "# hi", format: "md" });
      // auto-watched by the owner at publish; a stranger's edit should show up in the owner's inbox
      const manageToken = pub.manage_url.split("#k=")[1];
      await api.update(editor.key, pub.id, { content: "# edited by another" }, manageToken);
      const inbox = await api.inbox(owner.key);
      expect(inbox.items).toHaveLength(1);
      expect(inbox.items[0]).toMatchObject({ id: pub.id, rev: 2, seen_rev: 1 });
      expect(inbox.items[0].revisions).toHaveLength(1);
      expect(inbox.items[0].revisions[0].editor.key).toBe(editor.key.slice(0, 9));
      const seen = await api.inboxSeen(owner.key, pub.id, 2);
      expect(seen).toMatchObject({ id: pub.id, rev: 2, seen_rev: 2 });
      expect((await api.inbox(owner.key)).items).toHaveLength(0);
      await api.unwatch(owner.key, pub.id);
      await expect(api.unwatch(owner.key, pub.id)).rejects.toMatchObject({ status: 404, code: "not_watching" });
    });
    it("reading a revision clears that inbox entry without calling inboxSeen", async () => {
      const owner = await api.mint("owner");
      const editor = await api.mint("editor");
      const pub = await api.publish(owner.key, { content: "# hi", format: "md" });
      const manageToken = pub.manage_url.split("#k=")[1];
      await api.update(editor.key, pub.id, { content: "# edited by another" }, manageToken);
      expect((await api.inbox(owner.key)).items).toHaveLength(1);
      await api.getRevision(owner.key, pub.id, 2);
      expect((await api.inbox(owner.key)).items).toHaveLength(0);
    });
    it("watch is idempotent: re-watching with no body leaves seen_rev and the inbox unchanged", async () => {
      const owner = await api.mint("owner");
      const editor = await api.mint("editor");
      const pub = await api.publish(owner.key, { content: "# hi", format: "md" });
      const manageToken = pub.manage_url.split("#k=")[1];
      await api.update(editor.key, pub.id, { content: "# edit one" }, manageToken);
      await api.update(editor.key, pub.id, { content: "# edit two" }, manageToken);
      const before = await api.inbox(owner.key);
      expect(before.items[0]).toMatchObject({ rev: 3, seen_rev: 1 });
      const rewatch = await api.watch(owner.key, pub.id);
      expect(rewatch.seen_rev).toBe(1);
      const after = await api.inbox(owner.key);
      expect(after.items[0]).toMatchObject({ rev: 3, seen_rev: 1 });
      expect(after.items[0].revisions).toEqual(before.items[0].revisions);
    });
    it("does not show the watcher's own edits in their inbox", async () => {
      const { key } = await api.mint("x");
      const pub = await api.publish(key, { content: "# hi", format: "md" });
      await api.update(key, pub.id, { content: "# still me" });
      expect((await api.inbox(key)).items).toHaveLength(0);
    });
    it("204 resolves on unwatch, and a fresh watch call reports the current rev", async () => {
      const { key } = await api.mint("x");
      const pub = await api.publish(key, { content: "# hi", format: "md" });
      const w = await api.watch(key, pub.id);
      expect(w).toMatchObject({ id: pub.id, rev: 1, seen_rev: 1 });
      await expect(api.unwatch(key, pub.id)).resolves.toBeUndefined();
    });
    it("409s watch_limit once a key is already at the cap", async () => {
      const { key } = await api.mint("x");
      fake.watchLimit = 1;
      // publish auto-watches this key at 1/1 already
      const pub = await api.publish(key, { content: "# hi", format: "md" });
      const other = await api.publish(key, { content: "# another" });
      await expect(api.watch(key, other.id)).rejects.toMatchObject({ status: 409, code: "watch_limit" });
      expect((await api.watch(key, pub.id)).rev).toBe(1); // re-watching an already-watched page never hits the cap
    });
  });
});
