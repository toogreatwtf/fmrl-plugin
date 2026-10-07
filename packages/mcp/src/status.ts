import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import type { LastCall, MeResponse } from "./api.js";
import { DEFAULT_BASE_URL } from "./config.js";
import type { KeyFacts } from "./keys.js";
import { compareVersions, semverParts, type PluginSurface } from "./plugin.js";

/** ApiCheck is what verbose learned from one timed call to the API: reachable with the key's account, reachable without a key (a 401 probe), reachable but the key refused, or not reachable. */
export type ApiCheck =
  | { kind: "ok"; ms: number; me: MeResponse; inbox?: number }
  | { kind: "no_key"; ms: number }
  | { kind: "rejected"; ms: number; code: string }
  | { kind: "error"; ms: number; status: number; code: string }
  | { kind: "down"; why: string };

/** NpmCheck is what verbose learned from the npm registry about fmrl-mcp. */
export type NpmCheck = { kind: "latest"; version: string } | { kind: "skipped"; why: string } | { kind: "failed"; why: string };

/**
 * StatusSnapshot is everything fmrl_status says, gathered by the server and
 * rendered here. The default snapshot costs no network and no writes;
 * network is present only on a verbose call.
 */
export interface StatusSnapshot {
  server: string;
  upMs: number;
  client?: { name: string; version: string };
  surface: PluginSurface;
  pluginRoot?: string;
  /** pluginLine is plugin.pluginLine's sentence; undefined with no root, or a manifest that could not be read. */
  pluginLine?: string;
  /** installed and newerCached: the manifest version this session started on, and a newer one found beside it (newestCachedPlugin). */
  installed?: string;
  newerCached?: string;
  baseUrl: string;
  key?: KeyFacts;
  pages: number;
  lastCall?: LastCall;
  now: number;
  network?: { api: ApiCheck; npm: NpmCheck };
}

export const VERBOSE_HINT = "Network checks skipped: /fmrl:status verbose adds reachability, quota, inbox and npm.";
export const NO_PLUGIN_LINE = "Plugin: none (no CLAUDE_PLUGIN_ROOT): this server was started from an MCP config, not the fmrl plugin.";

const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;

/** upFor is a duration in the largest two units that fit: "45 s", "3 min", "2 h 13 min", "1 d 2 h". */
export function upFor(ms: number): string {
  if (ms < MIN) return `${Math.floor(ms / 1000)} s`;
  if (ms < HOUR) return `${Math.floor(ms / MIN)} min`;
  const two = (big: number, bigUnit: string, small: number, smallUnit: string) => (small > 0 ? `${big} ${bigUnit} ${small} ${smallUnit}` : `${big} ${bigUnit}`);
  if (ms < DAY) return two(Math.floor(ms / HOUR), "h", Math.floor((ms % HOUR) / MIN), "min");
  return two(Math.floor(ms / DAY), "d", Math.floor((ms % DAY) / HOUR), "h");
}

/** ago is how long ago, in one unit: "just now", "30 s ago", "4 min ago", "1 h ago", "2 d ago". */
export function ago(ms: number): string {
  if (ms < 5_000) return "just now";
  if (ms < MIN) return `${Math.floor(ms / 1000)} s ago`;
  if (ms < HOUR) return `${Math.floor(ms / MIN)} min ago`;
  if (ms < DAY) return `${Math.floor(ms / HOUR)} h ago`;
  return `${Math.floor(ms / DAY)} d ago`;
}

/**
 * newestCachedPlugin looks beside root — Claude Code's plugin cache keeps
 * one directory per installed version, named by it — for a version newer
 * than installed that carries a manifest. That is a plugin updated while
 * this session ran: the session keeps the root it started with, so only a
 * restart loads the new one. Anything unreadable answers undefined.
 */
export async function newestCachedPlugin(root: string, installed: string): Promise<string | undefined> {
  const have = semverParts(installed);
  if (!have) return undefined;
  let names: string[];
  try {
    names = (await readdir(path.dirname(root), { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return undefined;
  }
  let best: { name: string; parts: [number, number, number] } | undefined;
  for (const name of names) {
    const parts = semverParts(name);
    if (!parts || compareVersions(parts, have) <= 0 || (best && compareVersions(parts, best.parts) <= 0)) continue;
    try {
      await stat(path.join(path.dirname(root), name, ".claude-plugin", "plugin.json"));
    } catch {
      continue;
    }
    best = { name, parts };
  }
  return best?.name;
}

const SURFACE_NAME: Record<PluginSurface, string | undefined> = { "claude-cli": "Claude Code CLI", "claude-desktop": "the Claude desktop app", codex: "Codex", unknown: undefined };
const restart = (surface: PluginSurface) => (surface === "codex" ? "restart Codex" : surface === "unknown" ? "restart the client that started it" : "restart Claude Code");
const plural = (n: number, noun: string) => (n === 1 ? `1 ${noun}` : `${n} ${noun}s`);

function serverLine(s: StatusSnapshot): string {
  const by = s.client ? `${s.client.name} ${s.client.version}` : "an unknown client";
  const where = SURFACE_NAME[s.surface];
  return `fmrl-mcp ${s.server}, up ${upFor(s.upMs)}, launched by ${by}${where ? ` (${where})` : ""}.`;
}

function pluginLine(s: StatusSnapshot): string {
  const line = s.pluginLine ?? (s.pluginRoot ? `Plugin: manifest unreadable under ${s.pluginRoot}.` : NO_PLUGIN_LINE);
  if (!s.newerCached) return line;
  return `${line} Plugin ${s.newerCached} is already installed, but this session started on ${s.installed}: ${restart(s.surface)} to load it.`;
}

function keyLine(s: StatusSnapshot): string {
  const pages = s.pages === 0 ? "no pages remembered" : `${plural(s.pages, "page")} remembered`;
  const k = s.key;
  if (!k) return `API ${s.baseUrl}: no key yet, the first publish mints one (nothing was minted now); ${pages}.`;
  const key = k.source === "env" ? `key ${k.prefix}… from FMRL_API_KEY` : `key ${k.prefix}… from ${k.file}${k.createdAt ? `, minted ${k.createdAt.slice(0, 10)}` : ""}`;
  const ring = k.ring === "env" ? "key ring from FMRL_RING" : k.ring === "file" ? (k.source === "file" ? "key ring in that file" : `key ring in ${k.file}`) : "no key ring yet (the first private page mints one)";
  return `API ${s.baseUrl}: ${key}; ${ring}; ${pages}.`;
}

function lastCallLine(s: StatusSnapshot): string {
  const c = s.lastCall;
  if (!c) return "No API call yet this session.";
  const when = ago(s.now - c.at);
  if (c.status === 0) return `Last call: ${c.method} ${c.path} → failed (${c.code ?? "unknown"}) after ${c.ms} ms, ${when}.`;
  const code = c.status >= 400 && c.code ? ` (${c.code})` : "";
  return `Last call: ${c.method} ${c.path} → ${c.status}${code} in ${c.ms} ms, ${when}.`;
}

function apiLine(s: StatusSnapshot, a: ApiCheck): string {
  const site = s.baseUrl === DEFAULT_BASE_URL ? "fmrl.site" : s.baseUrl;
  switch (a.kind) {
    case "down":
      return `${site}: unreachable (${a.why}).`;
    case "no_key":
      return `${site}: reachable, ${a.ms} ms (answered 401 without a key, as expected).`;
    case "error":
      return `${site}: reachable, ${a.ms} ms, but GET /me answered ${a.status} (${a.code}).`;
    case "rejected":
      return `${site}: reachable, ${a.ms} ms, but it refused key ${s.key ? `${s.key.prefix}…` : "this key"} (${a.code}); nothing was replaced. fmrl_whoami says how to get a new one.`;
    case "ok": {
      const q = a.me.quota.publishes;
      const linked = a.me.linked_at ? `A browser linked on ${a.me.linked_at}.` : "No browser link recorded.";
      const inbox = a.inbox === undefined ? "" : a.inbox === 0 ? " Inbox: empty." : ` Inbox: ${plural(a.inbox, "page")} with unread revisions.`;
      return `${site}: reachable, ${a.ms} ms. Quota: ${q.used} of ${q.limit} publishes used this month, resets ${q.resets_at}. ${linked}${inbox}`;
    }
  }
}

function npmLine(s: StatusSnapshot, n: NpmCheck): string {
  if (n.kind === "skipped") return `npm: not checked (${n.why}).`;
  if (n.kind === "failed") return `npm: not reached (${n.why}).`;
  const latest = semverParts(n.version), running = semverParts(s.server);
  const cmp = latest && running ? compareVersions(latest, running) : 0;
  if (cmp > 0) return `npm: fmrl-mcp ${n.version} is the latest; this session runs ${s.server}, so ${restart(s.surface)} to pick it up.`;
  if (cmp < 0) return `npm: fmrl-mcp ${n.version} is the latest published; this session runs ${s.server}.`;
  return `npm: fmrl-mcp ${n.version} is the latest.`;
}

/** statusText renders a snapshot: server, plugin, key, last call, then either what verbose would add or what it found. */
export function statusText(s: StatusSnapshot): string {
  const tail = s.network ? [apiLine(s, s.network.api), npmLine(s, s.network.npm)] : [VERBOSE_HINT];
  return [serverLine(s), pluginLine(s), keyLine(s), lastCallLine(s), ...tail].join("\n");
}
