#!/usr/bin/env node
// e2e: talk to two built servers over stdio against FMRL_API_URL, as two
// separate keys — publish (public, private, named), read, list, edit, watch
// and inbox end to end. It mints real keys and publishes real pages
// wherever FMRL_API_URL points, so it refuses to run without one: point it
// at a local markymd.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

if (!process.env.FMRL_API_URL) {
  console.error("Set FMRL_API_URL (a local server, e.g. http://fmrl.localhost:8080): this script mints keys and publishes real pages.");
  process.exit(2);
}
// Tool text carries capabilities in link fragments — a page's key after #p=,
// the key ring after #r=<prefix>., a manage token after #k= — so nothing is
// printed until they are blanked; terminal and CI logs never hold one.
const redact = (s) => s.replace(/([#&](?:p|k)=)[A-Za-z0-9_-]+/g, "$1…").replace(/([#&]r=[A-Za-z0-9_]{1,16}\.)[A-Za-z0-9_-]+/g, "$1…");
let failed = 0;
// check redacts its line too: a failed check may quote a tool's own text.
const check = (ok, what) => { console.log(redact(`${ok ? "ok  " : "FAIL"} ${what}`)); if (!ok) failed++; };

const dir = mkdtempSync(path.join(tmpdir(), "fmrl-e2e-"));
const file = path.join(dir, "hello.md");
writeFileSync(file, "# Hello from fmrl-mcp\n\nPublished through the MCP server end to end.\n");
// An ambient FMRL_API_KEY would defeat the temp-dir isolation below (the
// server would use that key instead of minting its own), an ambient
// FMRL_RING would fail the "names the ring file" check, and an ambient
// FMRL_AGENT_NAME would collide with the name each connection sets below.
// FMRL_API_URL passes through untouched.
const { FMRL_API_KEY: _unusedApiKey, FMRL_RING: _unusedRing, FMRL_AGENT_NAME: _unusedName, ...childEnv } = process.env;

/** connect starts a fresh server process under its own config directory, so it mints its own key; agentName, when given, becomes that key's FMRL_AGENT_NAME. */
async function connect(label, clientName, agentName) {
  const home = mkdtempSync(path.join(tmpdir(), `fmrl-e2e-${label}-`));
  const env = { ...childEnv, XDG_CONFIG_HOME: home, APPDATA: home, ...(agentName ? { FMRL_AGENT_NAME: agentName } : {}) };
  const transport = new StdioClientTransport({ command: "node", args: [new URL("../dist/index.js", import.meta.url).pathname], env });
  const client = new Client({ name: clientName, version: "0" });
  await client.connect(transport);
  return client;
}

const a = await connect("a", "e2e-a", "Agent A");
const tools = (await a.listTools()).tools.map((t) => t.name);
console.log("tools:", tools.join(" "));
check(tools.includes("fmrl_list"), "fmrl_list is offered");
check(tools.length === 9, `nine tools offered (got ${tools.length})`);

const who = await a.callTool({ name: "fmrl_whoami", arguments: {} });
console.log("whoami:", redact(who.content[0].text.split("\n")[0]));
check(!who.isError && who.content[0].text.includes("Your key ring is in "), "whoami names the ring file");
check(who.content[0].text.includes("Named Agent A"), "FMRL_AGENT_NAME names the key");

const pub = await a.callTool({ name: "fmrl_publish_file", arguments: { path: file } });
console.log(redact(pub.isError ? "publish FAILED: " + pub.content[0].text : "publish:\n" + pub.content[0].text));
check(!pub.isError, "public publish");
const id = pub.structuredContent?.id;
if (id) {
  const got = await a.callTool({ name: "fmrl_get", arguments: { id } });
  console.log("get:", redact(got.content[0].text.split("\n")[0]));
}

const priv = await a.callTool({ name: "fmrl_publish", arguments: { content: "# Private from fmrl-mcp\n\nSealed end to end.", private: true } });
check(!priv.isError, "private publish with a sealed record" + (priv.isError ? ": " + priv.content[0].text : ""));
const keyed = priv.structuredContent?.url ?? "";
check(/#p=[A-Za-z0-9_-]{43}$/.test(keyed), "the private link carries its key after #p=");
for (const link of [who.structuredContent?.link_url, pub.structuredContent?.link_url, priv.structuredContent?.link_url].filter(Boolean)) {
  check(/#r=[A-Za-z0-9_]{1,16}\.[A-Za-z0-9_-]{43}$/.test(link), "a browser link carries the ring after #r=");
}

const list = await a.callTool({ name: "fmrl_list", arguments: {} });
console.log("list:\n" + redact(list.content[0].text));
const row = (list.structuredContent?.docs ?? []).find((d) => d.id === priv.structuredContent?.id);
check(row?.url === keyed && row?.title === "Private from fmrl-mcp", "fmrl_list opens the sealed record: title and keyed link");
const privGot = await a.callTool({ name: "fmrl_get", arguments: { id: priv.structuredContent?.id ?? "x" } });
check(privGot.structuredContent?.url === keyed, "fmrl_get opens it too");

// A second key, handed only the private page's combined link — its key
// after #p= and its manage token after #k= — watches it, then edits it
// (proving the manage token was remembered, since the second call passes
// only the bare id). Publishing already watches the page for the first
// key, so its inbox should show the second key's revision without a
// fmrl_watch call of its own.
const manageUrl = priv.structuredContent?.manage_url ?? "";
const manageToken = new URL(manageUrl).hash.match(/[#&]k=([A-Za-z0-9_-]+)/)?.[1];
const privId = priv.structuredContent?.id ?? "";
const combined = manageToken ? `${keyed}&k=${manageToken}` : keyed;
const b = await connect("b", "editor-b");

const watch = await b.callTool({ name: "fmrl_watch", arguments: { id: combined } });
console.log("watch:", redact(watch.content[0].text));
check(!watch.isError && watch.structuredContent?.can_open === true, "the second key opens the private page through the handed link");

const edit = await b.callTool({ name: "fmrl_edit", arguments: { id: privId, content: "# Private from fmrl-mcp\n\nEdited by the second key.", base_rev: watch.structuredContent?.rev } });
console.log("edit:", redact(edit.content[0].text));
check(!edit.isError, "the second key edits the page from the remembered key and manage token" + (edit.isError ? ": " + edit.content[0].text : ""));

const inbox = await a.callTool({ name: "fmrl_inbox", arguments: {} });
console.log("inbox:\n" + redact(inbox.content[0].text));
const inboxItem = (inbox.structuredContent?.items ?? []).find((it) => it.id === privId);
check(inboxItem !== undefined && inboxItem.rev === edit.structuredContent?.rev, "the first key's inbox shows the second key's revision");

await a.close();
await b.close();
process.exit(failed ? 1 : 0);
