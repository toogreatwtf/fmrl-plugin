#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { FmrlApi } from "./api.js";
import { alreadyOffered, autoUpdateState, claimOffer, shouldOffer, statePath } from "./autoupdate.js";
import { loadConfig } from "./config.js";
import { credentialsPath } from "./credentials.js";
import { KeyStore } from "./keys.js";
import { pluginStatus } from "./plugin.js";
import { createServer, VERSION } from "./server.js";

// stdout is the JSON-RPC channel; everything we say goes to stderr.
const log = (line: string) => process.stderr.write(line + "\n");

async function main(): Promise<void> {
  const cfg = loadConfig();
  const api = new FmrlApi(cfg.baseUrl);
  const keys = new KeyStore({ api, baseUrl: cfg.baseUrl, apiKeyFromEnv: cfg.apiKey, ringFromEnv: cfg.ring, file: credentialsPath(), log });
  // Whether anything is keeping the plugin current. Read once at startup,
  // as the plugin manifest is: neither changes without a restart.
  const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT;
  const autoUpdate = pluginRoot ? await autoUpdateState() : undefined;
  const state = statePath();
  // Read here as well as in createServer: a manifest we cannot read sends
  // no instructions, so the one offer must not be spent on that start.
  const plugin = pluginStatus(pluginRoot, VERSION);
  // Claimed rather than marked afterwards: the claim is what settles two
  // starts racing, and it is made here rather than when the agent relays
  // the offer, which the server cannot see. Asking once too few beats
  // asking every day.
  const offerAutoUpdate = shouldOffer(autoUpdate, await alreadyOffered(state), plugin !== undefined) && (await claimOffer(state));
  const server = createServer({ api, keys, log, pluginRoot, autoUpdate, offerAutoUpdate });
  await server.connect(new StdioServerTransport());
}

main().catch((e) => {
  log(`fmrl-mcp: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
