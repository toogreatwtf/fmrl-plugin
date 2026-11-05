import { randomUUID } from "node:crypto";
import { lstat, mkdir, open as fsOpen, realpath, rename, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/**
 * filesDir is the one folder fmrl_get's to_file writes to and fmrl_edit's content_file reads from: FMRL_FILES_DIR
 * when set (absolute, a leading ~ expanded), otherwise ~/fmrl. Keeping both in one dedicated folder means a planted
 * instruction can't have the agent upload a note from elsewhere on the machine, or write page content over one.
 */
export function filesDir(env: NodeJS.ProcessEnv = process.env, homedir: () => string = os.homedir): string {
  const raw = (env.FMRL_FILES_DIR ?? "").trim();
  if (raw === "") return path.join(homedir(), "fmrl");
  const win = process.platform === "win32";
  const p = raw === "~" || raw.startsWith("~/") || (win && raw.startsWith("~\\")) ? path.join(homedir(), raw.slice(1)) : raw;
  if (!path.isAbsolute(p)) throw new Error(`FMRL_FILES_DIR must be an absolute path (a leading ~ is expanded); ${raw} is not.`);
  return path.resolve(p);
}

/** openFilesDir makes the folder if it is missing (mode 0700, readable only by this user) and answers its real path. */
export async function openFilesDir(dir: string): Promise<string> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const real = await realpath(dir);
  if (!(await lstat(real)).isDirectory()) throw new Error(`The fmrl folder ${dir} is not a folder.`);
  return real;
}

/** inFolder is whether real (a resolved path) names something inside folder (also resolved), not the folder itself. */
export function inFolder(folder: string, real: string): boolean {
  const rel = path.relative(folder, real);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/** fileName is the name a page's content is written under: its id, cleaned to safe characters, and its format. */
export function fileName(id: string, format: "html" | "md"): string {
  return `${id.replace(/[^A-Za-z0-9_-]/g, "") || "page"}.${format}`;
}

/**
 * writeIn writes content to name inside folder (a real path from openFilesDir), replacing an earlier copy. It writes
 * a new temporary file first (O_CREAT|O_EXCL, mode 0600) and renames it into place, so a reader never sees half a
 * page, and a symlink planted under that name is replaced, never followed.
 */
export async function writeIn(folder: string, name: string, content: string): Promise<string> {
  const file = path.join(folder, name);
  const tmp = path.join(folder, `.${name}.${randomUUID()}.tmp`);
  const fh = await fsOpen(tmp, "wx", 0o600);
  try {
    await fh.writeFile(content);
    await fh.close();
    await rename(tmp, file);
  } catch (e) {
    await fh.close().catch(() => undefined);
    await unlink(tmp).catch(() => undefined);
    throw e;
  }
  return file;
}
