import { readFileSync } from "node:fs";
import path from "node:path";

import type { AutoUpdate } from "./autoupdate.js";
import { MARKETPLACE } from "./autoupdate.js";

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

// Strict SemVer 2.0.0: no leading zeros, and a prerelease or build suffix is
// dot-separated non-empty identifiers. Anything else is an odd manifest.
const IDENTS = "[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*";
const SEMVER = new RegExp(`^(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)(?:-${IDENTS})?(?:\\+${IDENTS})?$`);

function majorMinor(v: string): [number, number] | undefined {
  const m = SEMVER.exec(v);
  return m ? [Number(m[1]), Number(m[2])] : undefined;
}
const short = (v: string) => majorMinor(v)!.join(".");

/**
 * pluginStatus reads root/.claude-plugin/plugin.json, root being
 * CLAUDE_PLUGIN_ROOT, which Claude Code exports to a plugin's MCP servers.
 * No root (Cursor, a hand-written config), a manifest that is missing,
 * unreadable or carries no strict SemVer version, or an odd server version answer
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

/**
 * autoUpdateSteps is how an agent turns auto-update on for this
 * marketplace, when the user's settings say it is off. There is no command
 * and no field a marketplace author can set — it is a key in the user's own
 * settings file, so the agent asks first and writes it only on a yes.
 */
function autoUpdateSteps(a: AutoUpdate, n: number): string[] {
  return [
    `${n}. ${n === 1 ? "Offer" : "Then offer"} to keep the plugin current, so this does not come up again. Claude Code leaves auto-update off for marketplaces outside Anthropic's own, and a marketplace cannot turn it on for its users: it is the user's switch.`,
    `${n + 1}. Only once the user says yes, set \`autoUpdate\` to true on the \`${MARKETPLACE}\` entry under \`extraKnownMarketplaces\` in ${a.file}, leaving the rest of that file as it is. They can do the same by hand in /plugin → Marketplaces → ${MARKETPLACE} → Enable auto-update. Either way it takes effect at the next Claude Code start, and updates land on the start after the one that fetches them — so a long-running session can still be a release behind, which is what this notice is for.`,
  ];
}

/**
 * pluginInstructions is the MCP server instructions sent at initialize:
 * the plugin is out of date, or it is current but nothing is keeping it
 * that way. Both end in the same offer, and a machine where auto-update is
 * already on is told neither — which is the common case worth getting
 * right, since the switch being on is not a promise of a current plugin.
 *
 * undefined when there is nothing to say, including whenever no plugin
 * launched this server (another client, a hand-written config).
 */
export function pluginInstructions(s: PluginStatus | undefined, auto?: AutoUpdate): string | undefined {
  if (!s) return undefined;
  const offer = auto && !auto.on ? auto : undefined;
  if (!s.stale) {
    if (!offer) return undefined;
    return [
      "The fmrl plugin that launched this server is current, but nothing is keeping it that way: auto-update is off for its marketplace.",
      "",
      "Raise this with the user once, after you have finished their current request: never before it or instead of it. Do not raise it again if they say no.",
      ...autoUpdateSteps(offer, 1),
    ].join("\n");
  }
  const versions = `installed ${short(s.installed)}, fmrl-mcp is at ${short(s.server)}`;
  return [
    `The fmrl plugin that launched this server is out of date (${versions}). The fmrl tools are current, because npx runs the latest fmrl-mcp; the /fmrl:share skill and the plugin manifest are not.`,
    "",
    "Raise this with the user once per session, after you have finished the user's current request: never before it or instead of it.",
    `1. Say that the fmrl plugin is out of date: ${versions}.`,
    `2. Offer to update it. Run these only once the user says yes, and only if you can run shell commands and \`claude\` is on PATH: \`${MARKETPLACE_UPDATE}\`, then \`${PLUGIN_UPDATE}\`. Then tell them to restart Claude Code to load it.`,
    "3. If you can't run shell commands, or `claude` isn't on PATH, give them the steps instead. In Claude Code: run `/plugin marketplace update fmrl-plugin`, then open /plugin → Installed → fmrl → Update now, and restart. In the Claude desktop app: Settings → Plugins → Fmrl → Update.",
    ...(offer ? autoUpdateSteps(offer, 4) : []),
    "",
    "Never edit files under ~/.claude/plugins by hand. After the restart, /fmrl:whoami (the fmrl_whoami tool) says whether the plugin is up to date.",
  ].join("\n");
}

/**
 * pluginLine is fmrl_whoami's line about the plugin, whenever there is a
 * status to report. Asked directly, it also says whether anything is
 * keeping the plugin current — which a current plugin does not imply.
 */
export function pluginLine(s: PluginStatus | undefined, auto?: AutoUpdate): string | undefined {
  if (!s) return undefined;
  const keeping = auto === undefined ? "" : auto.on
    ? " Auto-update is on for its marketplace."
    : ` Auto-update is off for its marketplace: ${AUTO_UPDATE} keeps it current from the next start.`;
  if (!s.stale) return `The fmrl plugin is up to date (plugin ${s.installed}, fmrl-mcp ${s.server}).${keeping}`;
  const fix = `Update it with \`${MARKETPLACE_UPDATE}\` then \`${PLUGIN_UPDATE}\`, and restart Claude Code.`;
  return `The fmrl plugin is out of date: installed ${short(s.installed)}, fmrl-mcp is at ${short(s.server)}. ${fix}${keeping === "" ? ` ${AUTO_UPDATE} keeps it current.` : keeping}`;
}
