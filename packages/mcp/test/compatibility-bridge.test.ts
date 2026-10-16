import { mkdtemp, readFile, rm } from "node:fs/promises";
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

let fake: FakeApi, dir: string;
const clients: Client[] = [];
const token = "A".repeat(22);
const text = (r: {content: unknown}) => JSON.stringify(r.content);
beforeEach(async () => { fake = await startFakeApi({oneLiveAttach:true}); dir = await mkdtemp(path.join(tmpdir(),"fmrl-bridge-")); });
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(clients.splice(0).map(c=>c.close())); await fake.close(); await rm(dir,{recursive:true,force:true}); });
async function agent(name: string, contract: "legacy" | "identity" = "identity") {
 const api = new FmrlApi(fake.baseUrl, {fetchImpl:async (url,init) => {
  const response = await fetch(url,init);
  if (!response.ok || response.status===204 || contract==="identity") return response;
  const value = await response.json();
  const route = new URL(String(url)).pathname;
  if (route.endsWith("/me")) {
   value.linked_at = value.attached_at; delete value.attached_at;
   if (value.attach_url) value.link_url="https://fmrl.test/link/legacy";
   delete value.attach_url;
  }
  if (route.endsWith("/publish")) {
   value.manage_url=`https://fmrl.test/manage/${value.id}#k=${value.manage_url.split("/").at(-1)}`;
   delete value.recovery; delete value.attach_url;
  }
  const legacyEditor = (editor: Record<string,unknown>) => { editor.name=editor.label; delete editor.label; };
  if (value.editor) legacyEditor(value.editor);
  for (const item of value.items??[]) for(const r of item.revisions) legacyEditor(r.editor);
  return Response.json(value,{status:response.status});
 }});
 const keys = new KeyStore({api,baseUrl:fake.baseUrl,file:path.join(dir,`${name}-credentials.json`)});
 const pages = new PageStore(fake.baseUrl,path.join(dir,`${name}-pages.json`));
 const server = createServer({api,keys,pages});
 const [a,b]=InMemoryTransport.createLinkedPair(); await server.connect(b);
 const client=new Client({name,version:"bridge-test"});await client.connect(a);await client.listTools();clients.push(client);
 return {api,keys,pages,client,call:(name:string,args:Record<string,unknown>={})=>client.callTool({name,arguments:args})};
}
it.each(["fmrl_whoami","fmrl_publish"])("surfaces courtesy captured by startup on first %s, per key, until attached",async tool=>{
 const a=await agent("a"), b=await agent("b");
 const r=await a.call(tool,tool==="fmrl_publish"?{content:"hello"}:{});
 expect(r.isError).not.toBe(true);
 const link=(r.structuredContent as any).attach_url;
 expect(link).toMatch(/\/c\/[A-Za-z0-9_-]{22}#r=/);
 expect(text(r)).toContain(link);
 const again=await a.call("fmrl_whoami");expect((again.structuredContent as any).attach_url).toBe(link);
 const other=await b.call("fmrl_whoami");expect((other.structuredContent as any).attach_url).not.toBe(link);
 fake.linked.add((await a.keys.storedKey())!);
 const attached=await a.call("fmrl_whoami");expect(attached.structuredContent).not.toHaveProperty("attach_url");
 expect(text(attached)).not.toContain("No attach link");
 expect(fake.requests.filter(r=>r.method==="POST"&&r.path.endsWith("/me/attach"))).toHaveLength(0);
 expect(await readFile(path.join(dir,"a-credentials.json"),"utf8")).not.toContain(new URL(link).pathname);
});
it("a status probe's courtesy survives until whoami; a stale link is not extended",async()=>{
 const a=await agent("a");await a.keys.getKey();
 await a.call("fmrl_status",{verbose:true});
 const who=await a.call("fmrl_whoami");const link=(who.structuredContent as any).attach_url;
 expect(link).toMatch(/\/c\//);
 // Read the cache after its one-hour bound with only Date.now mocked; no fake network timers.
 const now=Date.now();vi.spyOn(Date,"now").mockReturnValue(now+3600001);
 // With an attached server response there can be no replacement mint or stale hint.
 fake.linked.add((await a.keys.storedKey())!);
 expect((await a.call("fmrl_whoami")).structuredContent).not.toHaveProperty("attach_url");
});
it.each(["legacy","identity"] as const)("strict client matrix: %s publish/whoami/read/inbox/edit and future fields",async contract=>{
 const a=await agent("a",contract),b=await agent("b",contract);
 const original=a.api.publish.bind(a.api);
 vi.spyOn(a.api,"publish").mockImplementation(async(k,p)=>({...await original(k,p),future_field:"not public"}));
 const p=await a.call("fmrl_publish",{content:"# first",format:"md"});expect(p.isError).not.toBe(true);
 const page=p.structuredContent as any;expect(page).not.toHaveProperty("future_field");
 const who=await a.call("fmrl_whoami");expect(who.isError).not.toBe(true);
 if(contract==="legacy") {
  expect(page).not.toHaveProperty("recovery");expect(who.structuredContent).not.toHaveProperty("attached_at");
  expect(text(who)).not.toContain("not attached");expect(text(p)).toContain("state is not reported");
 } else expect(page.recovery).toBe("usable");
 const stored=await a.pages.get(page.id);expect(stored.manage).toMatch(/^[A-Za-z0-9_-]{22}$/);
 const edited=await b.call("fmrl_edit",{id:page.url,manage_token:stored.manage,content:"# next",base_rev:1});expect(edited.isError).not.toBe(true);
 const inbox=await a.call("fmrl_inbox");expect(inbox.isError).not.toBe(true);expect(text(inbox)).toContain("b");
 const read=await a.call("fmrl_get",{id:page.id});expect(read.isError).not.toBe(true);expect(text(read)).toContain("# next");
 expect((await b.call("fmrl_delete",{id:page.id})).isError).toBe(true);
 expect(fake.requests.filter(r=>r.method==="POST"&&r.path.endsWith("/publish"))).toHaveLength(1);
});
it.each(["spent","revoked",undefined])("does not advertise or remember new recovery with state %s",async recovery=>{
 const a=await agent("a");
 vi.spyOn(a.api,"publish").mockResolvedValue({id:"abcdefghjkmn",url:"https://fmrl.test/abcdefghjkmn",raw_url:"https://fmrl.test/abcdefghjkmn/raw",manage_url:`https://fmrl.test/c/${token}`,expires_at:null,status:"live",recovery} as any);
 const r=await a.call("fmrl_publish",{content:"hello"});expect(r.isError).not.toBe(true);
 expect(await a.pages.get("abcdefghjkmn")).not.toHaveProperty("manage");
 expect(text(r)).not.toContain("grants management");
 expect(text(r)).toContain(recovery??"state is not reported");
});
it.each(["fmrl_get","fmrl_edit","fmrl_watch","fmrl_delete"])("redacts bare recovery mistaken for id in %s",async tool=>{
 const a=await agent("a");const r=await a.call(tool,{id:token,content:"edit"});
 expect(r.isError).toBe(true);expect(text(r)).not.toContain(token);expect(fake.requests).toHaveLength(0);
});
it("a malformed success is not republished and private keys survive reconciliation",async()=>{
 const a=await agent("a");const original=a.api.publish.bind(a.api);
 vi.spyOn(a.api,"publish").mockImplementation(async(k,p)=>({...await original(k,p),recovery:"not-valid"} as any));
 const r=await a.call("fmrl_publish",{content:"private",private:true});
 expect(r.isError).toBe(true);expect(text(r)).toContain("Do not republish");
 expect(fake.requests.filter(r=>r.method==="POST"&&r.path.endsWith("/publish"))).toHaveLength(1);
 const id=[...fake.docs.keys()][0];expect((await a.pages.get(id)).key).toHaveLength(43);
 expect((await a.call("fmrl_get",{id})).isError).not.toBe(true);
});

it("cached courtesy expires without extending on repeated observations and is not persisted across processes",async()=>{
 const a=await agent("a");const first=await a.call("fmrl_whoami");
 const key=(await a.keys.storedKey())!,link=(first.structuredContent as any).attach_url.split("#")[0];
 const now=Date.now();const clock=vi.spyOn(Date,"now");clock.mockReturnValue(now+1800000);
 a.api.noteAttachment(key,{attached_at:null,attach_url:link});
 expect(a.api.attachmentHint(key)).toBe(link);
 clock.mockReturnValue(now+3600001);expect(a.api.attachmentHint(key)).toBeUndefined();clock.mockRestore();
 const restarted=await agent("a");const after=await restarted.call("fmrl_whoami");
 expect(after.structuredContent).not.toHaveProperty("attach_url");
 expect(text(after)).toContain("does not replace");
 expect(fake.requests.some(r=>r.path.endsWith("/me/attach"))).toBe(false);
});
it.each(["spent","revoked"])("unusable %s recovery clears only the matching stored token and keeps the private key",async recovery=>{
 const a=await agent("a");const id="abcdefghjkmn",key="B".repeat(43);
 await a.pages.remember(id,{manage:token,key});
 vi.spyOn(a.api,"publish").mockResolvedValue({id,url:`https://fmrl.test/${id}`,raw_url:`https://fmrl.test/${id}/raw`,manage_url:`https://fmrl.test/c/${token}`,expires_at:null,status:"live",recovery} as any);
 expect((await a.call("fmrl_publish",{content:"replay"})).isError).not.toBe(true);
 expect(await a.pages.get(id)).toEqual({key});
 await a.pages.remember(id,{manage:"C".repeat(22)});
 await a.call("fmrl_publish",{content:"replay"});
 expect(await a.pages.get(id)).toEqual({key,manage:"C".repeat(22)});
});
it.each(["legacy","identity"] as const)("strict %s private publication keeps original page key and decrypts after edit",async contract=>{
 const a=await agent("a",contract),b=await agent("b",contract);
 const r=await a.call("fmrl_publish",{content:"# private",private:true});expect(r.isError).not.toBe(true);
 const p=r.structuredContent as any,stored=await a.pages.get(p.id);
 expect(p.url).toContain(`#p=${stored.key}`);
 const edit=await b.call("fmrl_edit",{id:p.url,manage_token:stored.manage,content:"# revised",base_rev:1});expect(edit.isError).not.toBe(true);
 const puts=fake.requests.filter(q=>q.method==="PUT"&&q.path.endsWith(`/docs/${p.id}`));
 expect(puts).toHaveLength(1);expect(JSON.stringify(puts[0].body)).not.toContain(stored.key!);
 expect((puts[0].body as any).content).toMatch(/^MARKYENC/);
 expect(text(await a.call("fmrl_get",{id:p.url}))).toContain("revised");
});
it.each(["fmrl_get","fmrl_inbox","fmrl_whoami"])("known malformed fields still fail %s without echoing values",async tool=>{
 const a=await agent("a");const id="abcdefghjkmn";
 fake.docs.set(id,{id,owner:"another",format:"md",size:4,rev:1});
 if(tool==="fmrl_get") vi.spyOn(a.api,"getRevision").mockResolvedValue({rev:1,at:"now",content:"hello",format:"md",editor:{kind:"key",label:{secret:token}}} as any);
 if(tool==="fmrl_inbox")vi.spyOn(a.api,"inbox").mockResolvedValue({items:[{id,url:`https://fmrl.test/${id}`,private:false,status:"live",rev:1,seen_rev:0,revisions:[{rev:1,at:"now",editor:{kind:"key",label:{secret:token}}}]}]});
 if(tool==="fmrl_whoami") {const me=a.api.me.bind(a.api);vi.spyOn(a.api,"me").mockImplementation(async(k,o)=>({...await me(k,o),attached_at:{secret:token}} as any));}
 const r=await a.call(tool,{id});expect(r.isError).toBe(true);expect(text(r)).not.toContain(token);
});
it("a timeout after server acceptance performs exactly one publish and warns against retry",async()=>{
 const a=await agent("a");const publish=a.api.publish.bind(a.api);
 vi.spyOn(a.api,"publish").mockImplementation(async(k,b)=>{await publish(k,b);throw new (await import("../src/api.js")).ApiError(0,"timeout","timeout");});
 const r=await a.call("fmrl_publish",{content:"# accepted"});expect(r.isError).toBe(true);expect(text(r)).toContain("Do not republish");
 expect(fake.docs.size).toBe(1);expect(fake.requests.filter(q=>q.method==="POST"&&q.path.endsWith("/publish"))).toHaveLength(1);
});
it("transitional schemas remain closed at the root and editor boundary",async()=>{
 const a=await agent("a");const tools=(await a.client.listTools()).tools;
 for(const name of ["fmrl_publish","fmrl_whoami","fmrl_get","fmrl_inbox"])expect(tools.find(t=>t.name===name)!.outputSchema!.additionalProperties).toBe(false);
 expect((tools.find(t=>t.name==="fmrl_get")!.outputSchema!.properties!.editor as any).additionalProperties).toBe(false);
});

it.each(["legacy","identity"] as const)("pinned %s server wire fixtures pass strict tool schemas",async contract=>{
 const wire=JSON.parse(await readFile(new URL(`./fixtures/${contract}-contract.json`,import.meta.url),"utf8"));
 const a=await agent("a",contract);
 vi.spyOn(a.api,"me").mockResolvedValue(wire.me);
 vi.spyOn(a.api,"setLabel").mockResolvedValue(wire.patch_me);
 const who=await a.call("fmrl_whoami");expect(who.isError).not.toBe(true);
 expect(who.structuredContent).not.toHaveProperty("principal");
 vi.spyOn(a.api,"publish").mockResolvedValue(wire.publish);
 const published=await a.call("fmrl_publish",{content:"fixture"});expect(published.isError).not.toBe(true);
 expect(published.structuredContent).toMatchObject({id:wire.publish.id,status:wire.publish.status});
 fake.docs.set(wire.publish.id,{id:wire.publish.id,owner:"another",format:wire.revision.format,size:wire.revision.size,rev:wire.revision.rev});
 vi.spyOn(a.api,"getRevision").mockResolvedValue(wire.revision);
 const read=await a.call("fmrl_get",{id:wire.publish.id});expect(read.isError).not.toBe(true);
 expect(read.structuredContent).toMatchObject({editor:wire.revision.editor});
 vi.spyOn(a.api,"inbox").mockResolvedValue(wire.inbox);
 expect((await a.call("fmrl_inbox")).isError).not.toBe(true);
 if(wire.publish_with_attach){
  vi.spyOn(a.api,"publish").mockResolvedValue(wire.publish_with_attach);
  const p=await a.call("fmrl_publish",{content:"with hint"});expect(p.isError).not.toBe(true);
  expect((p.structuredContent as any).attach_url).toContain(wire.publish_with_attach.attach_url);
 }
});

it("legacy management URLs still edit the named page without discovery",async()=>{
 const a=await agent("a","legacy"),b=await agent("b","legacy");
 const published=await a.call("fmrl_publish",{content:"# original"});const p=published.structuredContent as any;
 const edit=await b.call("fmrl_edit",{id:p.manage_url,content:"# changed",base_rev:1});
 expect(edit.isError).not.toBe(true);
 expect(fake.requests.some(q=>q.method==="GET"&&q.path.startsWith("/manage/"))).toBe(false);
 expect(fake.requests.filter(q=>q.method==="PUT"&&q.path.endsWith(`/docs/${p.id}`))).toHaveLength(1);
});
it("concurrent first calls share the one-live courtesy without automatic mint or token consumption",async()=>{
 const a=await agent("a");
 const results=await Promise.all([a.call("fmrl_whoami"),a.call("fmrl_publish",{content:"# concurrent"})]);
 for(const r of results)expect(r.isError).not.toBe(true);
 expect((results[0].structuredContent as any).attach_url).toBe((results[1].structuredContent as any).attach_url);
 expect(fake.requests.some(q=>q.method==="POST"&&q.path.endsWith("/me/attach"))).toBe(false);
});
