// oldnode answers for fmrl-mcp on a Node too old to run it. It imports
// only node: built-ins that Node 16 and 18 have, so it loads where the rest
// of the server would not, and says why instead of exiting with a stack
// trace the person never sees.
import { createInterface } from "node:readline";

/** MIN_NODE is the oldest Node major fmrl-mcp runs on, as package.json's engines says. */
export const MIN_NODE = 20;

/** nodeMajor is the major version in a process.versions.node string, 0 for anything odd. */
export function nodeMajor(version: string): number {
  const n = Number(version.split(".")[0]);
  return Number.isInteger(n) && n > 0 ? n : 0;
}

/** tooOldText is what the person is told, by the agent and in the server log. */
export const tooOldText = (version: string) =>
  `fmrl can't start: it needs Node ${MIN_NODE} or newer, and the node that ran it is ${version}. ` +
  `Update Node (https://nodejs.org, or your version manager), check that \`node --version\` in a new terminal shows ${MIN_NODE} or newer, then restart this app so it starts fmrl again.`;

type Message = { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown };

/**
 * tooOldReply is the JSON-RPC answer to one message: initialize succeeds,
 * with no tools and instructions that say what's wrong, so the client shows
 * the server connected and the agent can tell the person; tools/list is
 * empty; ping answers; any other request gets an error carrying the same
 * text. Notifications and anything that isn't a request get no answer.
 */
export function tooOldReply(msg: Message, version: string): object | undefined {
  if (typeof msg !== "object" || msg === null || typeof msg.method !== "string") return undefined;
  if (msg.id === undefined || msg.id === null) return undefined;
  const id = msg.id;
  const text = tooOldText(version);
  switch (msg.method) {
    case "initialize": {
      const asked = (msg.params as { protocolVersion?: unknown } | undefined)?.protocolVersion;
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: typeof asked === "string" ? asked : "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "fmrl", version: "unavailable" },
          instructions: `${text} Tell the person this before anything else fmrl-related; no fmrl tools are available until then.`,
        },
      };
    }
    case "tools/list":
      return { jsonrpc: "2.0", id, result: { tools: [] } };
    case "ping":
      return { jsonrpc: "2.0", id, result: {} };
    default:
      return { jsonrpc: "2.0", id, error: { code: -32601, message: text } };
  }
}

/** serveTooOld logs why fmrl can't start and answers the client with tooOldReply until it closes stdin. */
export function serveTooOld(version: string): void {
  process.stderr.write(`fmrl-mcp: ${tooOldText(version)}\n`);
  const lines = createInterface({ input: process.stdin });
  lines.on("line", (line) => {
    let msg: Message;
    try {
      msg = JSON.parse(line) as Message;
    } catch {
      return;
    }
    const reply = tooOldReply(msg, version);
    if (reply) process.stdout.write(JSON.stringify(reply) + "\n");
  });
  lines.on("close", () => process.exit(0));
}
