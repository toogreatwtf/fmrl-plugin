// Run against an explicitly supplied, locally built server with synthetic memory
// data only. Example: node scripts/check-server-compat.mjs --server-binary /tmp/server
// --server-root /tmp/source --server-commit <sha> --contract identity --port 18217
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer as netServer } from 'node:net';
import { mkdtemp, rm, open, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { FmrlApi } from '../dist/api.js';
import { KeyStore } from '../dist/keys.js';
import { PageStore } from '../dist/pages.js';
import { createServer } from '../dist/server.js';
const { values: args } = parseArgs({options:{'server-binary':{type:'string'},'server-root':{type:'string'},'server-commit':{type:'string'},contract:{type:'string'},port:{type:'string'},'write-fixture':{type:'string'}}});
assert(['legacy','identity'].includes(args.contract));assert.match(args['server-commit']??'',/^[a-f0-9]{40}$/);
assert(args['server-binary']&&args['server-root']);
const port=Number(args.port);assert(Number.isInteger(port)&&port>1024&&port<65536&&!([4443,4453,8081].includes(port)));
const base=`http://127.0.0.1:${port}`, identity=args.contract==='identity';
const probe=netServer();await new Promise((resolve,reject)=>{probe.once('error',reject);probe.listen(port,'0.0.0.0',resolve)});await new Promise(r=>probe.close(r));
const dir=await mkdtemp(join(tmpdir(),'fmrl-contract-')),log=await open(join(dir,'server.log'),'w');
const processEnv={PATH:'/usr/bin:/bin',PORT:String(port),STORE:'memory',DEFAULT_SITE:'fmrl',FMRL_EXTRA_HOSTS:'127.0.0.1',API_KEYS_PER_DAY:'100',API_PUBLISHES_PER_MONTH:'100'};
// Archive roots must not contain .env: never load deployment credentials.
try { await open(join(args['server-root'],'.env'),'r'); throw Error('Server root contains .env'); } catch(e) {if(e.code!=='ENOENT')throw e;}
const child=spawn(args['server-binary'],[],{cwd:args['server-root'],env:processEnv,stdio:['ignore',log.fd,log.fd]});
const clients=[],fixtures={},checks=[];
const pass=name=>{checks.push(name);console.log(`PASS ${args.contract}: ${name}`)};
const ok=r=>{assert(!r.isError,JSON.stringify(r));return r.structuredContent};
async function agent(name){
 const requests=[];
 const api=new FmrlApi(base,{fetchImpl:async(url,init)=>{
  assert.equal(new URL(url).origin,base);requests.push({url:String(url),method:init?.method,body:init?.body,headers:init?.headers});
  const response=await fetch(url,init),route=new URL(url).pathname;
  if(response.ok&&response.status!==204){
   let slot;
   if(route==='/api/v1/me')slot=init.method==='PATCH'?'patch_me':'me';
   if(route==='/api/v1/publish')slot='publish';
   if(/\/revisions\/\d+$/.test(route))slot='revision';
   if(route==='/api/v1/inbox')slot='inbox';
   if(route==='/api/v1/me/rotate')slot='rotate';
   if(slot){const body=await response.clone().json();if(slot==='rotate')delete body.key;if(!fixtures[slot])fixtures[slot]=body;if(slot==='publish'&&body.attach_url)fixtures.publish_with_attach=body;}
  }
  return response;
 }});
 const keys=new KeyStore({api,baseUrl:base,file:join(dir,`${name}-credentials.json`)}),pages=new PageStore(base,join(dir,`${name}-pages.json`));
 const server=createServer({api,keys,pages}),[c,s]=InMemoryTransport.createLinkedPair();await server.connect(s);
 const client=new Client({name,version:'contract-check'});await client.connect(c);await client.listTools();clients.push(client);
 return {api,keys,pages,requests,call:(name,args={})=>client.callTool({name,arguments:args})};
}
try{
 let ready=false;for(let i=0;i<100;i++){if(child.exitCode!==null)throw Error('server startup failed');try{if((await fetch(base)).ok){ready=true;break}}catch{}await new Promise(r=>setTimeout(r,100));}assert(ready);
 const a=await agent('owner'),b=await agent('manager'),c=await agent('other');
 const who=ok(await a.call('fmrl_whoami'));
 if(identity){assert.equal(who.attached_at,null);assert.match(who.attach_url,/\/c\/[A-Za-z0-9_-]{22}#r=/);assert(!('linked_at'in who));}
 else {assert.equal(who.linked_at,null);assert(!('attached_at'in who));assert(who.link_url.includes('#r='));}
 pass('strict whoami preserves linking/attachment semantics and ring hint');
 const page=ok(await a.call('fmrl_publish',{content:'# Original',format:'md'}));
 const first=ok(await c.call('fmrl_publish',{content:'# Publish first',format:'md'}));
 if(identity){assert.equal(page.recovery,'usable');assert.equal(page.attach_url,who.attach_url);assert.match(first.attach_url,/\/c\/[A-Za-z0-9_-]{22}#r=/);}
 else {assert(!('recovery'in page));assert.match(page.manage_url,/#k=/);}
 const token=(await a.pages.get(page.id)).manage;assert.match(token,/^[A-Za-z0-9_-]{22}$/);
 pass('strict publish including publish-first agent retains usable management proof');
 const before=b.requests.length;assert((await b.call('fmrl_get',{id:token})).isError);assert.equal(b.requests.length,before);
 pass('bare recovery as page id refused without requests');
 ok(await b.call('fmrl_edit',{id:page.url,manage_token:token,content:'# Edited',base_rev:1}));
 const put=b.requests.filter(r=>r.method==='PUT').at(-1);assert.equal(new Headers(put.headers).get('Fmrl-Manage-Token'),token);
 const inbox=ok(await a.call('fmrl_inbox'));assert(inbox.items.some(i=>i.id===page.id&&i.revisions.some(r=>r.editor.label==='manager'||r.editor.name==='manager')));
 const read=ok(await a.call('fmrl_get',{id:page.id}));assert(read.content.includes('Edited'));assert.equal(read.rev,2);
 pass('separate proof transmitted; strict read and inbox attribution accepted');
 assert((await b.call('fmrl_delete',{id:page.id})).isError);ok(await a.call('fmrl_get',{id:page.id}));
 pass('manager has no delete authority through the plugin');
 const priv=ok(await a.call('fmrl_publish',{content:'# Private original',private:true})),secret=priv.url.split('#p=')[1],proof=(await a.pages.get(priv.id)).manage;
 ok(await b.call('fmrl_edit',{id:priv.url,manage_token:proof,content:'# Private changed',base_rev:1}));
 const privatePut=b.requests.filter(r=>r.method==='PUT').at(-1),body=JSON.parse(privatePut.body);
 assert(body.encrypted&&body.content.startsWith('MARKYENC'));assert(!privatePut.body.includes(secret));assert(!privatePut.body.includes('Private changed'));
 assert(ok(await a.call('fmrl_get',{id:priv.url})).content.includes('Private changed'));
 pass('private cross-agent editing preserves encryption and owner decryption');
 if(identity){
  assert((await c.call('fmrl_edit',{id:page.id,manage_token:token,content:'spent'})).isError);
  await b.pages.forgetManage(page.id,token);
  ok(await b.call('fmrl_edit',{id:page.id,content:'# Durable role',base_rev:2}));
  assert(!new Headers(b.requests.filter(r=>r.method==='PUT').at(-1).headers).has('Fmrl-Manage-Token'));
  pass('spent recovery denied to a stranger while manager role persists');
  const conflictPage=ok(await a.call('fmrl_publish',{content:'# Conflict test'}));
  ok(await a.call('fmrl_edit',{id:conflictPage.id,content:'# Advanced',base_rev:1}));
  const conflict=await c.call('fmrl_edit',{id:conflictPage.id,manage_token:conflictPage.manage_url,content:'# Stale',base_rev:1});assert(conflict.isError);
  ok(await c.call('fmrl_edit',{id:conflictPage.id,content:'# Retry on role',base_rev:2}));
  pass('recovery role persists after conflict without replaying the token');
  const rotationPage=ok(await a.call('fmrl_publish',{content:'# Recovery rotation'}));
  const rotated=await fetch(`${base}/api/v1/docs/${rotationPage.id}/rotate`,{method:'POST',headers:{Authorization:`Bearer ${await a.keys.storedKey()}`}});assert.equal(rotated.status,200);const replacement=(await rotated.json()).manage_url;
  assert((await b.call('fmrl_edit',{id:rotationPage.id,manage_token:rotationPage.manage_url,content:'old'})).isError);
  ok(await b.call('fmrl_edit',{id:rotationPage.id,manage_token:replacement,content:'new'}));
  pass('rotated recovery rejects old proof and accepts replacement');
 }
 ok(await a.call('fmrl_rotate'));ok(await a.call('fmrl_whoami'));ok(await a.call('fmrl_get',{id:page.id}));
 pass('credential rotation preserves access and strict response compatibility');
 assert(![a,b,c].flatMap(x=>x.requests).some(r=>new URL(r.url).pathname.startsWith('/c/')||r.url.endsWith('/me/attach')));
 if(args['write-fixture']&&identity){const minted=await a.api.mint('fixture-only');await a.api.publish(minted.key,{content:'# Courtesy fixture'});}
 if(args['write-fixture'])await writeFile(args['write-fixture'],JSON.stringify({server_commit:args['server-commit'],contract:args.contract,provenance:'Captured from isolated STORE=memory server and synthetic agents. Rotation secret omitted. No production data.',...fixtures},null,2)+'\n');
 console.log(JSON.stringify({server:args['server-commit'],contract:args.contract,checks:checks.length,strict:true,publishIdempotency:'not implemented; no Idempotency-Key sent'}));
}finally{
 await Promise.allSettled(clients.map(c=>c.close()));child.kill('SIGTERM');
 await new Promise(r=>{if(child.exitCode!==null)r();else{child.once('exit',r);setTimeout(()=>{child.kill('SIGKILL');r()},10000).unref()}});
 await log.close();await rm(dir,{recursive:true,force:true});
}
