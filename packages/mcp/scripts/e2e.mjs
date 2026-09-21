#!/usr/bin/env node
// e2e: talk to the built server over stdio against FMRL_API_URL — publish a
// file and a private page, and list them back with the sealed record opened.
// It mints a real key and publishes real pages wherever FMRL_API_URL points,
// so it refuses to run without one: point it at a local markymd.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

if (!process.env.FMRL_API_URL) {
  console.error("Set FMRL_API_URL (a local server, e.g. http://fmrl.localhost:8080): this script mints a key and publishes real pages.");
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
// server would use that key instead of minting its own), and an ambient
// FMRL_RING would fail the "names the ring file" check. Strip both for the
// child; FMRL_API_URL passes through untouched.
const { FMRL_API_KEY: _unusedApiKey, FMRL_RING: _unusedRing, ...childEnv } = process.env;
const transport = new StdioClientTransport({ command: "node", args: [new URL("../dist/index.js", import.meta.url).pathname], env: { ...childEnv, XDG_CONFIG_HOME: dir, APPDATA: dir } });
const client = new Client({ name: "e2e", version: "0" });
await client.connect(transport);
const tools = (await client.listTools()).tools.map((t) => t.name);
console.log("tools:", tools.join(" "));
check(tools.includes("fmrl_list"), "fmrl_list is offered");
const who = await client.callTool({ name: "fmrl_whoami", arguments: {} });
console.log("whoami:", redact(who.content[0].text.split("\n")[0]));
check(!who.isError && who.content[0].text.includes("Your key ring is in "), "whoami names the ring file");
const pub = await client.callTool({ name: "fmrl_publish_file", arguments: { path: file } });
console.log(redact(pub.isError ? "publish FAILED: " + pub.content[0].text : "publish:\n" + pub.content[0].text));
check(!pub.isError, "public publish");
const id = pub.structuredContent?.id;
if (id) {
  const got = await client.callTool({ name: "fmrl_get", arguments: { id } });
  console.log("get:", redact(got.content[0].text.split("\n")[0]));
}
const priv = await client.callTool({ name: "fmrl_publish", arguments: { content: "# Private from fmrl-mcp\n\nSealed end to end.", private: true } });
check(!priv.isError, "private publish with a sealed record" + (priv.isError ? ": " + priv.content[0].text : ""));
const keyed = priv.structuredContent?.url ?? "";
check(/#p=[A-Za-z0-9_-]{43}$/.test(keyed), "the private link carries its key after #p=");
for (const link of [who.structuredContent?.link_url, pub.structuredContent?.link_url, priv.structuredContent?.link_url].filter(Boolean)) {
  check(/#r=[A-Za-z0-9_]{1,16}\.[A-Za-z0-9_-]{43}$/.test(link), "a browser link carries the ring after #r=");
}
const list = await client.callTool({ name: "fmrl_list", arguments: {} });
console.log("list:\n" + redact(list.content[0].text));
const row = (list.structuredContent?.docs ?? []).find((d) => d.id === priv.structuredContent?.id);
check(row?.url === keyed && row?.title === "Private from fmrl-mcp", "fmrl_list opens the sealed record: title and keyed link");
const privGot = await client.callTool({ name: "fmrl_get", arguments: { id: priv.structuredContent?.id ?? "x" } });
check(privGot.structuredContent?.url === keyed, "fmrl_get opens it too");
await client.close();
process.exit(failed ? 1 : 0);
