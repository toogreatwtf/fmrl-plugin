import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * PluginStatus is how the Claude Code plugin that launched this server
 * compares with the server itself. Claude Code leaves auto-update off for
 * third-party marketplaces, so a plugin stays at the version it was
 * installed at while npx keeps the server current.
 */
export interface PluginStatus {
  installed: string;
  server: string;
  /** stale is the plugin's major.minor behind the server's: patch releases never count. */
  stale: boolean;
}

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/;

function majorMinor(v: string): [number, number] | undefined {
  const m = SEMVER.exec(v);
  return m ? [Number(m[1]), Number(m[2])] : undefined;
}
const short = (v: string) => majorMinor(v)!.join(".");

/**
 * pluginStatus reads root/.claude-plugin/plugin.json, root being
 * CLAUDE_PLUGIN_ROOT, which Claude Code exports to a plugin's MCP servers.
 * No root (Cursor, a hand-written config), a manifest that is missing,
 * unreadable or carries no x.y.z version, or an odd server version answer
 * undefined: say nothing rather than guess.
 */
export function pluginStatus(root: string | undefined, server: string): PluginStatus | undefined {
  if (!root) return undefined;
  let installed: unknown;
  try {
    installed = (JSON.parse(readFileSync(path.join(root, ".claude-plugin", "plugin.json"), "utf8")) as { version?: unknown } | null)?.version;
  } catch {
    return undefined;
  }
  if (typeof installed !== "string") return undefined;
  const have = majorMinor(installed);
  const want = majorMinor(server);
  if (!have || !want) return undefined;
  const stale = have[0] < want[0] || (have[0] === want[0] && have[1] < want[1]);
  return { installed, server, stale };
}

const MARKETPLACE_UPDATE = "claude plugin marketplace update fmrl-plugin";
const PLUGIN_UPDATE = "claude plugin update fmrl@fmrl-plugin";
const AUTO_UPDATE = "/plugin → Marketplaces → fmrl-plugin → Enable auto-update";

/** pluginInstructions is the MCP server instructions for a stale plugin, sent at initialize; undefined otherwise. */
export function pluginInstructions(s: PluginStatus | undefined): string | undefined {
  if (!s?.stale) return undefined;
  const versions = `installed ${short(s.installed)}, fmrl-mcp is at ${short(s.server)}`;
  return [
    `The fmrl plugin that launched this server is out of date (${versions}). The fmrl tools are current, because npx runs the latest fmrl-mcp; the /fmrl:share skill and the plugin manifest are not.`,
    "",
    "Raise this with the user once per session, after you have finished the user's current request: never before it or instead of it.",
    `1. Say that the fmrl plugin is out of date: ${versions}.`,
    `2. Offer to update it. Run these only once the user says yes, and only if you can run shell commands and \`claude\` is on PATH: \`${MARKETPLACE_UPDATE}\`, then \`${PLUGIN_UPDATE}\`. Then tell them to restart Claude Code to load it.`,
    "3. If you can't run shell commands, or `claude` isn't on PATH, give them the steps instead. In Claude Code: run `/plugin marketplace update fmrl-plugin`, then open /plugin → Installed → fmrl → Update now, and restart. In the Claude desktop app: Settings → Plugins → Fmrl → Update.",
    `4. Then walk them through turning on auto-update, so the plugin keeps itself current: ${AUTO_UPDATE}. There is no command for this; it is a switch they flip in the plugin manager. Claude Code leaves auto-update off for marketplaces outside Anthropic's own.`,
    "",
    "Never edit files under ~/.claude/plugins by hand. After the restart, fmrl_whoami says whether the plugin is up to date.",
  ].join("\n");
}

/** pluginLine is fmrl_whoami's line about the plugin, whenever there is a status to report. */
export function pluginLine(s: PluginStatus | undefined): string | undefined {
  if (!s) return undefined;
  if (!s.stale) return `The fmrl plugin is up to date (plugin ${s.installed}, fmrl-mcp ${s.server}).`;
  return `The fmrl plugin is out of date: installed ${short(s.installed)}, fmrl-mcp is at ${short(s.server)}. Update it with \`${MARKETPLACE_UPDATE}\` then \`${PLUGIN_UPDATE}\`, and restart Claude Code; ${AUTO_UPDATE} keeps it current.`;
}
