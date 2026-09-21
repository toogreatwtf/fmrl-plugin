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

/**
 * moveAside is readCredentials' recovery for a file it cannot trust: it is
 * never overwritten in place, only renamed out of the way, because it may
 * hold the one copy of a key ring. A rename that loses to another reader
 * (ENOENT) is fine — the file is already moved; any other rename failure
 * means the original is left exactly where it was, and the caller must not
 * proceed to write a fresh file over it.
 */
async function moveAside(file: string, reason: string, log?: (line: string) => void): Promise<CredentialsFile> {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const aside = `${file}.unreadable-${stamp}`;
  try {
    await rename(file, aside);
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === "ENOENT") return { ...EMPTY, keys: {} };
    throw new Error(`Couldn't read ${file} (${reason}) or move it aside (${err.message}); fmrl-mcp won't overwrite it. Fix or move that file.`);
  }
  log?.(`fmrl-mcp: couldn't read ${file} (${reason}); moved it to ${aside} and started a new one. Your old key and key ring are in that file.`);
  return { ...EMPTY, keys: {} };
}

/**
 * readCredentials treats a missing file as empty. Anything else it cannot
 * trust — unreadable, unparseable, or not a version-1 credentials file — is
 * moved aside rather than silently replaced, since the file may be the only
 * copy of a stored key's ring; see moveAside. Unknown top-level fields
 * (everything but rings, which is re-sanitized) round-trip untouched, and a
 * malformed rings entry is dropped.
 */
export async function readCredentials(file: string, log?: (line: string) => void): Promise<CredentialsFile> {
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === "ENOENT") return { ...EMPTY, keys: {} };
    return moveAside(file, err.message, log);
  }
  let parsed: Partial<CredentialsFile>;
  try {
    parsed = JSON.parse(raw) as Partial<CredentialsFile>;
  } catch {
    // Not the parse error's own message: V8 quotes a fragment of the
    // offending input in it, which could be part of a ring.
    return moveAside(file, "not valid JSON", log);
  }
  // keys must be a record: typeof [] is "object" too, and an array would read
  // as holding no key for any base URL, so the next write would replace it.
  if (parsed && typeof parsed === "object" && parsed.version === 1 && parsed.keys && typeof parsed.keys === "object" && !Array.isArray(parsed.keys)) {
    const { rings, ...rest } = parsed;
    const out: CredentialsFile = { ...(rest as object), version: 1, keys: { ...parsed.keys } } as CredentialsFile;
    const sanitized = Object.entries(rings && typeof rings === "object" ? rings : {}).filter(([, r]) => isRing(r));
    if (sanitized.length > 0) out.rings = Object.fromEntries(sanitized);
    return out;
  }
  return moveAside(file, "not a version 1 credentials file", log);
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
