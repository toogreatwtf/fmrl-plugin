import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { FmrlApi } from "../src/api.js";
import { KeyStore } from "../src/keys.js";
import { PageStore } from "../src/pages.js";
import { createServer } from "../src/server.js";
import { startFakeApi, type FakeApi } from "./fake-api.js";

let fake: FakeApi, api: FmrlApi, client: Client, dir: string, pages: PageStore;
const token = "A".repeat(22);
const call = (name: string, args: Record<string, unknown> = {}) => client.callTool({ name, arguments: args });
beforeEach(async () => {
 fake = await startFakeApi();
 dir = await mkdtemp(path.join(tmpdir(), "fmrl-identity-"));
 api = new FmrlApi(fake.baseUrl);
 pages = new PageStore(fake.baseUrl, path.join(dir, "pages.json"));
 const keys = new KeyStore({ api, baseUrl: fake.baseUrl, file: path.join(dir, "credentials.json") });
 const server = createServer({ api, keys, pages });
 const [a,b] = InMemoryTransport.createLinkedPair();
 await server.connect(b); client = new Client({ name:"identity-test", version:"1" }); await client.connect(a); await client.listTools();
});
afterEach(async () => { await client.close(); await fake.close(); await rm(dir, { recursive:true, force:true }); });

it("issue29 reproduction: strict client accepts whoami with new wire fields, but exposes only declared fields", async () => {
 const original = api.me.bind(api);
 vi.spyOn(api, "me").mockImplementation(async (key, opts) => ({
  ...await original(key, opts), attached_at:null, attach_url:"https://fmrl.test/attach/abc",
  display_name:"Agent", principal:{ id:"agent-fixture", kind:"agent" }, future_field:"not part of the public MCP schema",
 }));
 const r = await call("fmrl_whoami");
 expect(r.isError).not.toBe(true);
 expect(r.structuredContent).toMatchObject({ attached_at:null });
 expect(r.structuredContent).not.toHaveProperty("future_field");
 expect(r.structuredContent).not.toHaveProperty("linked_at");
 expect(JSON.stringify(r.content)).toContain("Attach this agent to your identity: open");
});

it.each([token, `https://fmrl.test/c/${token}`])("edits with page and recovery supplied separately: %s", async recovery => {
 fake.docs.set("abcdefghjkmn", { id:"abcdefghjkmn", owner:"another-key", format:"html", size:1, manageToken:token });
 const r = await call("fmrl_edit", { id:"https://fmrl.test/abcdefghjkmn", manage_token:recovery, content:"<p>edit</p>" });
 expect(r.isError).not.toBe(true);
 expect(fake.requests.find(q => q.method==="PUT" && q.path.endsWith("/abcdefghjkmn"))?.manageToken).toBe(token);
 expect(await pages.get("abcdefghjkmn")).toMatchObject({ manage:token });
 expect(fake.requests.some(q => q.path.startsWith("/c/"))).toBe(false);
 expect(fake.docs.get("abcdefghjkmn")?.manageToken).toBeUndefined();
 const again = await call("fmrl_edit", { id:"abcdefghjkmn", content:"second edit" });
 expect(again.isError).not.toBe(true);
 const stranger = await api.mint("stranger");
 await expect(api.update(stranger.key, "abcdefghjkmn", { content:"stolen" }, token)).rejects.toMatchObject({ status:404 });
 const deletion = await call("fmrl_delete", { id:"abcdefghjkmn" });
 expect(deletion.isError).toBe(true);
 expect(fake.docs.get("abcdefghjkmn")?.removed).not.toBe(true);
});

it("refuses a recovery link as page without discovery, spending, or leaking its token", async () => {
 const r = await call("fmrl_get", { id:`https://fmrl.test/c/${token}` });
 expect(r.isError).toBe(true);
 expect(fake.requests).toHaveLength(0);
 expect(JSON.stringify(r.content)).not.toContain(token);
 expect(JSON.stringify(r.content)).toContain("manage_token");
});

it.each(["bad", `https://fmrl.test/c/${token}/extra`, `https://fmrl.test/manage/abcdefghjkmn#k=${token}`, `https://fmrl.test/c/${token}?x=1`])("refuses malformed recovery input before any request: %s", async recovery => {
 const r = await call("fmrl_edit", { id:"abcdefghjkmn", manage_token:recovery, content:"edit" });
 expect(r.isError).toBe(true);
 expect(fake.requests).toHaveLength(0);
 expect(await pages.get("abcdefghjkmn")).toEqual({});
});

it("remembers a published /c/ recovery and never describes it as deletion authority", async () => {
 const original = api.publish.bind(api);
 vi.spyOn(api,"publish").mockImplementation(async (key, body) => {
  const p = await original(key,body);
  return { ...p, manage_url:`https://fmrl.test/c/${token}`, attach_url:"https://fmrl.test/attach/abc" };
 });
 const r = await call("fmrl_publish", { content:"hello" });
 expect(r.isError).not.toBe(true);
 const p = r.structuredContent as { id:string };
 expect(await pages.get(p.id)).toMatchObject({ manage:token });
 expect(JSON.stringify(r.content)).not.toContain("removes the page");
 expect(JSON.stringify(r.content)).toContain("not remove");
});

it.each(["mismatched", "rotated", "spent"])("refused %s recovery is not remembered or retried through discovery", async state => {
 fake.docs.set("abcdefghjkmn", { id:"abcdefghjkmn", owner:"another", format:"html", size:1, manageToken: state === "spent" ? undefined : "B".repeat(22) });
 const r = await call("fmrl_edit", { id:"abcdefghjkmn", manage_token:token, content:"no" });
 expect(r.isError).toBe(true);
 expect(await pages.get("abcdefghjkmn")).toEqual({});
 expect(fake.docs.get("abcdefghjkmn")?.rev).toBeUndefined();
 expect(fake.requests.some(q => q.path.startsWith("/c/"))).toBe(false);
});

it("publish replay retains its recovery but does not invent an attach hint or ring", async () => {
 vi.spyOn(api,"publish").mockResolvedValue({ id:"abcdefghjkmn", url:"https://fmrl.test/abcdefghjkmn", raw_url:"https://fmrl.test/abcdefghjkmn/raw", manage_url:`https://fmrl.test/c/${token}`, expires_at:"2026-11-01T00:00:00Z", status:"live" });
 const r = await call("fmrl_publish", { content:"replay" });
 expect(r.isError).not.toBe(true);
 expect(r.structuredContent).not.toHaveProperty("attach_url");
 expect(JSON.stringify(r.content)).not.toContain("Attach this agent");
 expect(await pages.get("abcdefghjkmn")).toEqual({ manage:token });
});

it("whoami advertises required nullable attached_at and no legacy aliases", async () => {
 const tool = (await client.listTools()).tools.find(t => t.name === "fmrl_whoami")!;
 expect(tool.outputSchema?.required).toContain("attached_at");
 expect(tool.outputSchema?.properties).not.toHaveProperty("linked_at");
 expect(tool.outputSchema?.properties).not.toHaveProperty("link_url");
});
