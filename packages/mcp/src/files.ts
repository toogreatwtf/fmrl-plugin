import { randomUUID } from "node:crypto";
import { link, lstat, mkdir, open as fsOpen, readFile, realpath, rename, unlink } from "node:fs/promises";
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

/**
 * openFilesDir makes the folder if it is missing (mode 0700, readable only by this user) and answers its real path.
 * A folder that already exists is used only if it is this user's and no one else can write in it, so another
 * account on a shared machine can't plant or swap the files fmrl_edit uploads.
 */
export async function openFilesDir(dir: string): Promise<string> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const real = await realpath(dir);
  const st = await lstat(real);
  if (!st.isDirectory()) throw new Error(`The fmrl folder ${dir} is not a folder.`);
  if (process.platform !== "win32" && typeof process.getuid === "function") {
    if (st.uid !== process.getuid()) throw new Error(`The fmrl folder ${dir} belongs to another user, so fmrl won't read or write files in it. Set FMRL_FILES_DIR to a folder of your own.`);
    if ((st.mode & 0o022) !== 0) throw new Error(`Other users can write in the fmrl folder ${dir}, so fmrl won't read or write files in it. Make it private (chmod 700 ${dir}) or set FMRL_FILES_DIR to another folder.`);
  }
  return real;
}

/** fileStem is the part of a page's file name before the extension: its id, cleaned to safe characters. */
export function fileStem(id: string): string {
  return id.replace(/[^A-Za-z0-9_-]/g, "") || "page";
}

/** fileName is the name a page's content is written under: its id, cleaned to safe characters, and its format. */
export function fileName(id: string, format: "html" | "md"): string {
  return `${fileStem(id)}.${format}`;
}

/** FileInTheWay is writeIn's refusal: name is already in the folder and holds something else, so it was left as it was. */
export class FileInTheWay extends Error {
  constructor(readonly file: string) {
    super(`${file} is already there and holds something else`);
  }
}

/**
 * writeIn writes content to name inside folder (a real path from openFilesDir). It writes a new temporary file first
 * (O_CREAT|O_EXCL, mode 0600) and then puts it in place, so a reader never sees half a page. Without replace, the
 * file is put in place only if nothing is there yet (a hard link, which fails on an existing name, symlinks
 * included, or an exclusive create where hard links aren't supported); a regular file already there with exactly this content is left as it is, and anything else there is
 * left alone and FileInTheWay is thrown. With replace, it is renamed into place, so an earlier copy, or a symlink
 * planted under that name, is replaced, never followed.
 */
export async function writeIn(folder: string, name: string, content: string, opts: { replace?: boolean } = {}): Promise<string> {
  const file = path.join(folder, name);
  const tmp = path.join(folder, `.${name}.${randomUUID()}.tmp`);
  const fh = await fsOpen(tmp, "wx", 0o600);
  try {
    await fh.writeFile(content);
    await fh.close();
    if (opts.replace) {
      await rename(tmp, file);
      return file;
    }
    try {
      try {
        await link(tmp, file);
      } catch (e) {
        // A filesystem without hard links: create the file itself exclusively instead.
        if ((e as NodeJS.ErrnoException).code === "EEXIST") throw e;
        await writeNew(file, content);
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      if (!(await holds(file, content))) throw new FileInTheWay(file);
    }
    await unlink(tmp).catch(() => undefined);
  } catch (e) {
    await fh.close().catch(() => undefined);
    await unlink(tmp).catch(() => undefined);
    throw e;
  }
  return file;
}

/** writeNew creates file (O_CREAT|O_EXCL, mode 0600) and writes content to it, removing it again if the write fails. */
async function writeNew(file: string, content: string): Promise<void> {
  const fh = await fsOpen(file, "wx", 0o600);
  try {
    await fh.writeFile(content);
    await fh.close();
  } catch (e) {
    await fh.close().catch(() => undefined);
    await unlink(file).catch(() => undefined);
    throw e;
  }
}

/** holds is whether file is a regular file (not a link) whose content is exactly content. */
async function holds(file: string, content: string): Promise<boolean> {
  const st = await lstat(file).catch(() => undefined);
  if (!st?.isFile() || st.size !== Buffer.byteLength(content)) return false;
  return (await readFile(file, "utf8").catch(() => undefined)) === content;
}
