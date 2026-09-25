import { readFile } from "node:fs/promises";
import path from "node:path";
import { credentialsPath, moveAside, writeJsonFile } from "./credentials.js";

/** PageSecrets is what this machine remembers about one page: its content key (private pages only) and/or its manage token. */
export interface PageSecrets {
  key?: string;
  manage?: string;
}

interface PagesFile {
  version: 1;
  pages: Record<string, Record<string, PageSecrets>>;
}

const EMPTY: PagesFile = { version: 1, pages: {} };

/** pagesPath is pages.json, beside credentials.json: the same directory, keyed the same way by API base URL. */
export function pagesPath(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  const mod = platform === "win32" ? path.win32 : path;
  return mod.join(mod.dirname(credentialsPath(env, platform)), "pages.json");
}

const PAGES_NOTE = "Your old page keys and manage tokens are in that file.";

/**
 * readPages treats a missing file as empty. Anything else it cannot trust —
 * unreadable, unparseable, or not a version-1 pages file — is moved aside
 * rather than silently replaced, the same way readCredentials protects
 * credentials.json; see moveAside.
 */
async function readPages(file: string): Promise<PagesFile> {
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === "ENOENT") return { ...EMPTY, pages: {} };
    return moveAside(file, err.message, { ...EMPTY, pages: {} }, PAGES_NOTE);
  }
  let parsed: Partial<PagesFile>;
  try {
    parsed = JSON.parse(raw) as Partial<PagesFile>;
  } catch {
    return moveAside(file, "not valid JSON", { ...EMPTY, pages: {} }, PAGES_NOTE);
  }
  // pages must be a record: typeof [] is "object" too, and an array would
  // read as holding no page for any base URL, so the next write would
  // replace it.
  if (parsed && typeof parsed === "object" && parsed.version === 1 && parsed.pages && typeof parsed.pages === "object" && !Array.isArray(parsed.pages)) {
    return { version: 1, pages: { ...parsed.pages } };
  }
  return moveAside(file, "not a version 1 pages file", { ...EMPTY, pages: {} }, PAGES_NOTE);
}

/**
 * PageStore remembers, per API base URL, the pages this machine has opened
 * or published: a private page's content key and/or a manage token. It
 * never sends what it holds anywhere; the file is 0600 in a 0700 directory,
 * written atomically, and moved aside (never overwritten) when it can't be
 * trusted.
 */
export class PageStore {
  private readonly file: string;
  /** fileQueue orders this store's read-modify-write cycles, as KeyStore.fileQueue does for credentials.json. */
  private fileQueue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly baseUrl: string,
    file?: string,
  ) {
    this.file = file ?? pagesPath();
  }

  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.fileQueue.then(fn, fn);
    this.fileQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /** get reads what this machine remembers about id; an id it has never seen reads as {}. */
  async get(id: string): Promise<PageSecrets> {
    const file = await readPages(this.file);
    return { ...file.pages[this.baseUrl]?.[id] };
  }

  /** remember merges s into what is stored for id: an undefined field in s leaves the stored value for that field as it was. */
  async remember(id: string, s: PageSecrets): Promise<void> {
    await this.serialize(async () => {
      const file = await readPages(this.file);
      const forBase = { ...file.pages[this.baseUrl] };
      const existing = forBase[id] ?? {};
      forBase[id] = {
        key: s.key ?? existing.key,
        manage: s.manage ?? existing.manage,
      };
      file.pages = { ...file.pages, [this.baseUrl]: forBase };
      await writeJsonFile(this.file, file);
    });
  }
}
