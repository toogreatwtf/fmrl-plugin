#!/usr/bin/env node
// e2e: talk to the built server over stdio against FMRL_API_URL and publish one page.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const dir = mkdtempSync(path.join(tmpdir(), "fmrl-e2e-"));
const file = path.join(dir, "hello.md");
writeFileSync(file, "# Hello from fmrl-mcp\n\nPublished through the MCP server end to end.\n");
const transport = new StdioClientTransport({ command: "node", args: [new URL("../dist/index.js", import.meta.url).pathname], env: { ...process.env, XDG_CONFIG_HOME: dir } });
const client = new Client({ name: "e2e", version: "0" });
await client.connect(transport);
const tools = (await client.listTools()).tools.map((t) => t.name);
console.log("tools:", tools.join(" "));
const who = await client.callTool({ name: "fmrl_whoami", arguments: {} });
console.log("whoami:", who.content[0].text.split("\n")[0]);
const pub = await client.callTool({ name: "fmrl_publish_file", arguments: { path: file } });
console.log(pub.isError ? "publish FAILED: " + pub.content[0].text : "publish:\n" + pub.content[0].text);
const id = pub.structuredContent?.id;
if (id) {
  const got = await client.callTool({ name: "fmrl_get", arguments: { id } });
  console.log("get:", got.content[0].text.split("\n")[0]);
}
await client.close();
