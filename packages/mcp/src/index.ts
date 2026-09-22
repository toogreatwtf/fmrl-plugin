#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { FmrlApi } from "./api.js";
import { loadConfig } from "./config.js";
import { credentialsPath } from "./credentials.js";
import { KeyStore } from "./keys.js";
import { PageStore, pagesPath } from "./pages.js";
import { createServer } from "./server.js";

// stdout is the JSON-RPC channel; everything we say goes to stderr.
const log = (line: string) => process.stderr.write(line + "\n");

async function main(): Promise<void> {
  const cfg = loadConfig(process.env, log);
  const api = new FmrlApi(cfg.baseUrl);
  const keys = new KeyStore({ api, baseUrl: cfg.baseUrl, apiKeyFromEnv: cfg.apiKey, ringFromEnv: cfg.ring, file: credentialsPath(), log });
  const pages = new PageStore(cfg.baseUrl, pagesPath());
  const server = createServer({ api, keys, pages, log, agentName: cfg.agentName });
  await server.connect(new StdioServerTransport());
}

main().catch((e) => {
  log(`fmrl-mcp: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
