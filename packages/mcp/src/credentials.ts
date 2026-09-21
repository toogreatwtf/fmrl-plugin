import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isRing } from "./crypto.js";

export interface StoredKey {
  key: string;
  prefix: string;
  created_at: string;
  /** ring seals this key's private pages' records. Minted the first time one is needed; it leaves this machine only inside a browser link's fragment. */
  ring?: string;
}

export interface CredentialsFile {
  version: 1;
  keys: Record<string, StoredKey>;
  /**
   * rings holds, by key prefix, the rings of keys that are not the stored
   * key for their base URL: a key from FMRL_API_KEY, and a key replaced
   * after a 401, whose pages still exist and whose records open only under it.
   */
  rings?: Record<string, string>;
}

const EMPTY: CredentialsFile = { version: 1, keys: {} };

/**
 * credentialsPath is $XDG_CONFIG_HOME/fmrl/credentials.json (default
 * ~/.config) on macOS and Linux, and %APPDATA%\fmrl\credentials.json on
 * Windows. Keyed by API base URL inside, so one file serves every host.
 */
export function credentialsPath(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  homedir: () => string = os.homedir,
): string {
  if (platform === "win32") {
    const base = (env.APPDATA ?? "").trim() || path.win32.join(homedir(), "AppData", "Roaming");
    return path.win32.join(base, "fmrl", "credentials.json");
  }
  const xdg = (env.XDG_CONFIG_HOME ?? "").trim();
  const base = xdg !== "" ? xdg : path.join(homedir(), ".config");
  return path.join(base, "fmrl", "credentials.json");
}

/** readCredentials treats a missing, unreadable, or malformed file as empty, and drops a malformed entry from rings. */
export async function readCredentials(file: string): Promise<CredentialsFile> {
  try {
    const parsed = JSON.parse(await readFile(file, "utf8")) as Partial<CredentialsFile>;
    if (parsed && parsed.version === 1 && parsed.keys && typeof parsed.keys === "object") {
      const out: CredentialsFile = { version: 1, keys: { ...parsed.keys } };
      const rings = Object.entries(parsed.rings && typeof parsed.rings === "object" ? parsed.rings : {}).filter(([, r]) => isRing(r));
      if (rings.length > 0) out.rings = Object.fromEntries(rings);
      return out;
    }
    return { ...EMPTY, keys: {} };
  } catch {
    return { ...EMPTY, keys: {} };
  }
}

/** writeCredentials writes to a sibling temp file with mode 0600 and renames it into place. */
export async function writeCredentials(file: string, data: CredentialsFile): Promise<void> {
  const dir = path.dirname(file);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") await chmod(dir, 0o700);
  const tmp = path.join(dir, `.credentials.json.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
  await writeFile(tmp, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
  await rename(tmp, file);
}
