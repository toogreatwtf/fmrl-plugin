import { randomBytes } from "node:crypto";
import { link, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { credentialsPath } from "./credentials.js";

/** MARKETPLACE is this plugin's marketplace, as .claude-plugin/marketplace.json names it. */
export const MARKETPLACE = "fmrl-plugin";

/**
 * AutoUpdate is what the user's settings say about keeping this
 * marketplace current. `file` is the settings file it was read from, so a
 * message can name the one an agent would edit.
 */
export interface AutoUpdate {
  on: boolean;
  file: string;
}

/**
 * settingsPath is the user settings file Claude Code reads:
 * $CLAUDE_CONFIG_DIR/settings.json when that is set, else
 * ~/.claude/settings.json. Project and managed settings can also carry the
 * flag; this is the one a user is told to edit, and the one an agent may
 * write with their consent.
 */
export function settingsPath(env: NodeJS.ProcessEnv = process.env, homedir: () => string = os.homedir): string {
  const dir = (env.CLAUDE_CONFIG_DIR ?? "").trim();
  return dir !== "" ? path.join(dir, "settings.json") : path.join(homedir(), ".claude", "settings.json");
}

/**
 * autoUpdateState reads settingsPath and reports whether auto-update is on
 * for our marketplace. Claude Code leaves it off for marketplaces outside
 * Anthropic's own, and there is no field a marketplace author can set: the
 * switch is the user's, in `extraKnownMarketplaces`, and only `true` counts.
 *
 * It answers undefined — say nothing — whenever the answer is not ours to
 * give: no settings file, one we cannot parse, or no entry for this
 * marketplace, which is what a plugin installed some other way looks like.
 */
export async function autoUpdateState(
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = os.homedir,
): Promise<AutoUpdate | undefined> {
  const file = settingsPath(env, homedir);
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(file, "utf8"));
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
  const all = (parsed as { extraKnownMarketplaces?: unknown }).extraKnownMarketplaces;
  if (typeof all !== "object" || all === null || Array.isArray(all)) return undefined;
  const mine = (all as Record<string, unknown>)[MARKETPLACE];
  if (typeof mine !== "object" || mine === null || Array.isArray(mine)) return undefined;
  return { on: (mine as { autoUpdate?: unknown }).autoUpdate === true, file };
}

/**
 * statePath is fmrl's own state file, beside the credentials file so one
 * fmrl directory holds everything this server keeps. It carries no secrets:
 * only what has already been said to the user, so it is not said again.
 */
export function statePath(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  homedir: () => string = os.homedir,
): string {
  return path.join(path.dirname(credentialsPath(env, platform, homedir)), "state.json");
}

/** alreadyOffered reports whether the auto-update offer has been made on this machine. Anything unreadable reads as "not yet". */
export async function alreadyOffered(file: string): Promise<boolean> {
  try {
    const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
    if (typeof parsed !== "object" || parsed === null) return false;
    return typeof (parsed as { autoUpdateOfferedAt?: unknown }).autoUpdateOfferedAt === "string";
  } catch {
    return false;
  }
}

/**
 * claimOffer is the check and the mark in one: it reports whether this
 * start is the one that makes the offer, and records it so no later start
 * does.
 *
 * The file is created by writing a sibling temp file and hard-linking it
 * into place, which is atomic in both senses: only one start can win the
 * link, and the file never exists half-written, so a racing reader cannot
 * see an empty file and claim as well. (An exclusive create would settle
 * the name but not the content — three concurrent starts offered twice
 * before this was a link.) An existing file without the marker is merged
 * and renamed over, keeping what else it holds.
 *
 * It never throws: a machine that cannot record this is one that asks
 * again, which is better than a server that fails to start.
 */
export async function claimOffer(file: string): Promise<boolean> {
  const dir = path.dirname(file);
  const body = (state: Record<string, unknown>) => JSON.stringify({ ...state, version: 1, autoUpdateOfferedAt: new Date().toISOString() }, null, 2) + "\n";
  const read = async (): Promise<{ state: Record<string, unknown>; marked: boolean; exists: boolean }> => {
    try {
      const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return { state: {}, marked: false, exists: true };
      const state = parsed as Record<string, unknown>;
      return { state, marked: typeof state.autoUpdateOfferedAt === "string", exists: true };
    } catch (e) {
      // Missing is a file to create; anything else unreadable is replaced.
      return { state: {}, marked: false, exists: (e as NodeJS.ErrnoException).code !== "ENOENT" };
    }
  };
  let tmp: string | undefined;
  try {
    const before = await read();
    if (before.marked) return false;
    await mkdir(dir, { recursive: true });
    tmp = path.join(dir, `.state.json.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
    await writeFile(tmp, body(before.state));
    if (!before.exists) {
      try {
        await link(tmp, file);
        return true;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
        // Another start got there first: its file decides.
        if ((await read()).marked) return false;
      }
    }
    await rename(tmp, file);
    tmp = undefined;
    return true;
  } catch {
    return false;
  } finally {
    if (tmp !== undefined) await unlink(tmp).catch(() => undefined);
  }
}

/**
 * shouldOffer decides whether this start is one that would carry the
 * offer at all: the settings say it is off, and the plugin's own version
 * could be read, since a start that cannot read it sends no instructions
 * for the offer to ride in. Whether it is the first such start is
 * claimOffer's question, not this one's.
 */
export function shouldOffer(auto: AutoUpdate | undefined, offered: boolean, pluginKnown = true): boolean {
  return auto !== undefined && !auto.on && !offered && pluginKnown;
}
