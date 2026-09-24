import { mkdir, readFile, writeFile } from "node:fs/promises";
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
 * markOffered records that the offer has been made, keeping whatever else
 * the file holds. It never throws: a machine where this cannot be written
 * is one that is offered again, which is better than a server that fails
 * to start over a note to self.
 */
export async function markOffered(file: string): Promise<void> {
  try {
    let state: Record<string, unknown> = {};
    try {
      const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) state = parsed as Record<string, unknown>;
    } catch {
      // A file that is missing or unreadable is replaced, not merged.
    }
    state.version = 1;
    state.autoUpdateOfferedAt = new Date().toISOString();
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(state, null, 2) + "\n");
  } catch {
    // Nothing here is worth failing a session for.
  }
}

/**
 * shouldOffer decides whether this start is the one that offers the
 * switch: only when the settings say it is off, and only the first time on
 * a machine. A user who says no is not asked again; a user who says yes
 * has nothing left to be asked about.
 */
export function shouldOffer(auto: AutoUpdate | undefined, offered: boolean): boolean {
  return auto !== undefined && !auto.on && !offered;
}
