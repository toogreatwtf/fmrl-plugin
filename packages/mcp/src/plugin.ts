import { readFileSync } from "node:fs";
import path from "node:path";

import type { AutoUpdate, AutoUpdatePass } from "./autoupdate.js";
import { MARKETPLACE } from "./autoupdate.js";

export type PluginSurface = "claude-cli" | "claude-desktop" | "codex" | "unknown";

/** A shared plugin manifest/root identifies an installation, not its launcher. */
export function pluginSurface(env: NodeJS.ProcessEnv): PluginSurface {
  if (env.CODEX_THREAD_ID) return "codex";
  if (env.CLAUDE_CODE_ENTRYPOINT === "claude-desktop") return "claude-desktop";
  if (env.CLAUDE_CODE_ENTRYPOINT === "cli") return "claude-cli";
  return "unknown";
}

/** userAgent is how fmrl-mcp introduces itself to fmrl.site: its version and the app it runs in. */
export function userAgent(version: string, surface: PluginSurface): string {
  return `fmrl-mcp/${version} (${surface})`;
}

function otherSurfaceLine(s: PluginStatus, surface: PluginSurface): string {
  const status = s.stale
    ? `The fmrl plugin is out of date: installed ${short(s.installed)}, fmrl-mcp is at ${short(s.server)}.`
    : `The fmrl plugin is up to date (plugin ${s.installed}, fmrl-mcp ${s.server}).`;
  if (!s.stale) return status;
  return `${status} Check for plugin updates in ${surface === "claude-desktop" ? "the Claude desktop app's plugin settings" : surface === "codex" ? "Codex's plugin settings" : "the client that installed it"}.`;
}

/**
 * PluginStatus is how the installed plugin that launched this server
 * compares with the server itself. Claude Code leaves auto-update off for
 * third-party marketplaces, so a plugin stays at the version it was
 * installed at. A plugin from before 0.17.2 runs whatever npm has newest, so
 * it falls behind its own server; from 0.17.2 on the plugin pins the server
 * (pinnedServer), so the two move together.
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

/** semverParts is a strict SemVer string's major, minor and patch; undefined for anything else. A prerelease or build suffix is ignored. */
export function semverParts(v: string): [number, number, number] | undefined {
  const m = SEMVER.exec(v);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : undefined;
}
/** compareVersions orders two strict SemVer strings on major, minor, patch: negative, zero or positive, as a sort comparator. */
export function compareVersions(a: [number, number, number], b: [number, number, number]): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}
function majorMinor(v: string): [number, number] | undefined {
  const p = semverParts(v);
  return p ? [p[0], p[1]] : undefined;
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

/**
 * pinnedServer is the exact fmrl-mcp version the plugin at root starts:
 * the `fmrl-mcp@<version>` argument in root/.mcp.json. A plugin from before
 * 0.17.2, an unpinned or ranged argument, or a file that is missing or odd
 * answers undefined: that plugin runs whatever npm has newest.
 */
export function pinnedServer(root: string | undefined): string | undefined {
  if (!root) return undefined;
  let args: unknown;
  try {
    args = (JSON.parse(readFileSync(path.join(root, ".mcp.json"), "utf8")) as { mcpServers?: { fmrl?: { args?: unknown } } } | null)?.mcpServers?.fmrl?.args;
  } catch {
    return undefined;
  }
  if (!Array.isArray(args)) return undefined;
  for (const a of args) {
    const m = typeof a === "string" ? /^fmrl-mcp@(.+)$/.exec(a) : null;
    if (m && semverParts(m[1])) return m[1];
  }
  return undefined;
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

/** disabledBy is why the auto-update pass cannot run, for a sentence that says so. */
const disabledBy = (pass: AutoUpdatePass) => (pass.desktop ? "the Claude desktop app disables it" : `${pass.by} is set`);

/**
 * pluginInstructions is the MCP server instructions sent at initialize:
 * the plugin is out of date, or it is current but nothing is keeping it
 * that way. Both end in the same offer, and a machine where auto-update is
 * already on is told neither — which is the common case worth getting
 * right, since the switch being on is not a promise of a current plugin.
 *
 * Where the auto-update pass cannot run (pass.runs false: the Claude
 * desktop app, or a CLI with the auto-updater disabled), the switch does
 * nothing, so the offer is never made and a current plugin gets no notice;
 * the stale notice says why the commands are the way.
 *
 * undefined when there is nothing to say, including whenever no plugin
 * launched this server (another client, a hand-written config).
 */
export function pluginInstructions(s: PluginStatus | undefined, auto?: AutoUpdate, pass?: AutoUpdatePass, surface: PluginSurface = "unknown"): string | undefined {
  if (!s) return undefined;
  if (surface !== "claude-cli") return s.stale ? otherSurfaceLine(s, surface) : undefined;
  const disabled = pass !== undefined && !pass.runs;
  const offer = auto && !auto.on && !disabled ? auto : undefined;
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
  const why = disabled ? ` Auto-update cannot run here (${disabledBy(pass)}), so this is how the plugin updates.` : "";
  return [
    `The fmrl plugin that launched this server is out of date (${versions}). The fmrl tools are current, because npx runs the latest fmrl-mcp; the /fmrl:share skill and the plugin manifest are not.${why}`,
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
 * PREFER_THIS_SERVER is the first thing this server's instructions say,
 * every start: a session can have the hosted fmrl connector connected too,
 * with tools of the same names, and the model should not pick between them
 * at random. This server holds this machine's key and key ring, opens and
 * publishes private pages, and reads and writes files here; the connector
 * holds a key of its own and handles public pages only. The connector stays
 * for apps where this server isn't installed.
 */
export const PREFER_THIS_SERVER = [
  "This is the local fmrl server (fmrl-mcp), started by the fmrl plugin or a local MCP config.",
  "If another server in this session also offers fmrl tools (fmrl_publish, fmrl_whoami and the rest), such as the hosted fmrl.site connector, use this server's tools for every fmrl request and do not call the other server's.",
  "This server holds this machine's fmrl key and key ring, publishes and opens private pages, and reads and writes files here; the hosted connector has a key of its own and handles public pages only. It is for apps where this server isn't installed.",
].join(" ");

/**
 * serverInstructions is what this server sends at initialize: always
 * PREFER_THIS_SERVER, then pluginInstructions' notice when there is one.
 */
export function serverInstructions(s: PluginStatus | undefined, auto?: AutoUpdate, pass?: AutoUpdatePass, surface: PluginSurface = "unknown"): string {
  const notice = pluginInstructions(s, auto, pass, surface);
  return notice ? `${PREFER_THIS_SERVER}\n\n${notice}` : PREFER_THIS_SERVER;
}

/**
 * pluginLine is fmrl_whoami's line about the plugin, whenever there is a
 * status to report. Asked directly, it also says whether anything is
 * keeping the plugin current — which a current plugin does not imply.
 * Where the auto-update pass cannot run, the switch's state is irrelevant
 * and is not reported: the line says the pass does not run here, and that
 * the plugin updates by hand or when it says it is out of date.
 */
export function pluginLine(s: PluginStatus | undefined, auto?: AutoUpdate, pass?: AutoUpdatePass, surface: PluginSurface = "unknown"): string | undefined {
  if (!s) return undefined;
  if (surface !== "claude-cli") return otherSurfaceLine(s, surface);
  if (pass !== undefined && !pass.runs) {
    const where = pass.desktop ? "in the Claude desktop app" : `here: the auto-updater is disabled (${pass.by})`;
    if (!s.stale) return `The fmrl plugin is up to date (plugin ${s.installed}, fmrl-mcp ${s.server}). Auto-update does not run ${where}, so it updates by hand, or when this plugin says it is out of date.`;
    return `The fmrl plugin is out of date: installed ${short(s.installed)}, fmrl-mcp is at ${short(s.server)}. Update it with \`${MARKETPLACE_UPDATE}\` then \`${PLUGIN_UPDATE}\`, and restart Claude Code. Auto-update does not run ${where}, so this is how it updates.`;
  }
  const keeping = auto === undefined ? "" : auto.on
    ? " Auto-update is on for its marketplace."
    : ` Auto-update is off for its marketplace: ${AUTO_UPDATE} keeps it current from the next start.`;
  if (!s.stale) return `The fmrl plugin is up to date (plugin ${s.installed}, fmrl-mcp ${s.server}).${keeping}`;
  const fix = `Update it with \`${MARKETPLACE_UPDATE}\` then \`${PLUGIN_UPDATE}\`, and restart Claude Code.`;
  return `The fmrl plugin is out of date: installed ${short(s.installed)}, fmrl-mcp is at ${short(s.server)}. ${fix}${keeping}`;
}
