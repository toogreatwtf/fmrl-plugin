import { mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { pagesPath, PageStore } from "../src/pages.js";

/** oneUnreadableFile finds the single `${base}.unreadable-*` sibling the store left behind. */
async function oneUnreadableFile(dir: string, base: string): Promise<string> {
  const names = (await readdir(dir)).filter((n) => n.startsWith(`${base}.unreadable-`));
  expect(names).toHaveLength(1);
  return path.join(dir, names[0]);
}

describe("pagesPath", () => {
  it("sits beside credentials.json", () => {
    expect(pagesPath({ XDG_CONFIG_HOME: "/xdg" }, "linux")).toBe("/xdg/fmrl/pages.json");
  });
  it("falls back to ~/.config on linux and darwin", () => {
    // No homedir override in pagesPath's own signature, so exercise the real
    // default indirectly through XDG_CONFIG_HOME instead of touching $HOME.
    expect(pagesPath({ XDG_CONFIG_HOME: "/xdg" }, "darwin")).toBe("/xdg/fmrl/pages.json");
  });
  it("uses APPDATA on windows", () => {
    expect(pagesPath({ APPDATA: "C:\\Users\\u\\AppData\\Roaming" }, "win32")).toBe(
      path.win32.join("C:\\Users\\u\\AppData\\Roaming", "fmrl", "pages.json"),
    );
  });
});

describe("PageStore", () => {
  const baseUrl = "https://fmrl.test";
  const otherBase = "https://fmrl.site";
  const id = "8apmpes8t6pk";
  const key = "K".repeat(43);
  const key2 = "L".repeat(43);
  const manage = "M".repeat(22);

  it("returns nothing for an id it has never seen", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "fmrl-"));
    const store = new PageStore(baseUrl, path.join(dir, "pages.json"));
    expect(await store.get(id)).toEqual({});
  });

  it("remembers a key and manage token, and reads them back", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "fmrl-"));
    const file = path.join(dir, "pages.json");
    const store = new PageStore(baseUrl, file);
    await store.remember(id, { key, manage });
    expect(await store.get(id)).toEqual({ key, manage });
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({
      version: 1,
      pages: { [baseUrl]: { [id]: { key, manage } } },
    });
  });

  it("merges: a later remember with only one field leaves the other alone", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "fmrl-"));
    const file = path.join(dir, "pages.json");
    const store = new PageStore(baseUrl, file);
    await store.remember(id, { key });
    expect(await store.get(id)).toEqual({ key });
    await store.remember(id, { manage });
    expect(await store.get(id)).toEqual({ key, manage });
    await store.remember(id, { key: key2 });
    expect(await store.get(id)).toEqual({ key: key2, manage });
  });

  it("isolates pages by base URL within the same file", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "fmrl-"));
    const file = path.join(dir, "pages.json");
    const a = new PageStore(baseUrl, file);
    const b = new PageStore(otherBase, file);
    await a.remember(id, { key });
    expect(await b.get(id)).toEqual({});
    await b.remember(id, { manage });
    expect(await a.get(id)).toEqual({ key });
    expect(await b.get(id)).toEqual({ manage });
  });

  it("serializes concurrent remembers instead of racing", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "fmrl-"));
    const file = path.join(dir, "pages.json");
    const store = new PageStore(baseUrl, file);
    await Promise.all([
      store.remember("aaaaaaaaaaaa", { key: "A".repeat(43) }),
      store.remember("bbbbbbbbbbbb", { key: "B".repeat(43) }),
      store.remember("cccccccccccc", { key: "C".repeat(43) }),
    ]);
    expect(await store.get("aaaaaaaaaaaa")).toEqual({ key: "A".repeat(43) });
    expect(await store.get("bbbbbbbbbbbb")).toEqual({ key: "B".repeat(43) });
    expect(await store.get("cccccccccccc")).toEqual({ key: "C".repeat(43) });
  });

  it("writes atomically with 0600 and creates the directory with 0700", async () => {
    if (process.platform === "win32") return;
    const dir = await mkdtemp(path.join(tmpdir(), "fmrl-"));
    const file = path.join(dir, "cfg", "fmrl", "pages.json");
    const store = new PageStore(baseUrl, file);
    await store.remember(id, { key });
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect((await stat(path.dirname(file))).mode & 0o777).toBe(0o700);
    expect(await readdir(path.dirname(file))).toEqual(["pages.json"]);
  });

  it("tightens an already-existing directory's permissions to 0700", async () => {
    if (process.platform === "win32") return;
    const { mkdir } = await import("node:fs/promises");
    const dir = await mkdtemp(path.join(tmpdir(), "fmrl-"));
    const pagesDir = path.join(dir, "fmrl");
    await mkdir(pagesDir, { recursive: true, mode: 0o755 });
    const file = path.join(pagesDir, "pages.json");
    const store = new PageStore(baseUrl, file);
    await store.remember(id, { key });
    expect((await stat(pagesDir)).mode & 0o777).toBe(0o700);
  });

  it("moves an unparseable file aside with its bytes intact, and starts empty", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "fmrl-"));
    const file = path.join(dir, "pages.json");
    const original = "{not json";
    await writeFile(file, original);
    const store = new PageStore(baseUrl, file);
    expect(await store.get(id)).toEqual({});
    const aside = await oneUnreadableFile(dir, "pages.json");
    expect(await readFile(aside, "utf8")).toBe(original);
    await expect(stat(file)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("moves a wrong-version file aside the same way", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "fmrl-"));
    const file = path.join(dir, "pages.json");
    const original = JSON.stringify({ version: 2, pages: {} });
    await writeFile(file, original);
    const store = new PageStore(baseUrl, file);
    expect(await store.get(id)).toEqual({});
    const aside = await oneUnreadableFile(dir, "pages.json");
    expect(await readFile(aside, "utf8")).toBe(original);
  });

  it("moves a file whose pages is an array aside rather than accepting it", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "fmrl-"));
    const file = path.join(dir, "pages.json");
    const original = JSON.stringify({ version: 1, pages: [{ id, key }] });
    await writeFile(file, original);
    const store = new PageStore(baseUrl, file);
    expect(await store.get(id)).toEqual({});
    const aside = await oneUnreadableFile(dir, "pages.json");
    expect(await readFile(aside, "utf8")).toBe(original);
  });

  it("recovers after a corrupt file is moved aside: a later remember writes a fresh file", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "fmrl-"));
    const file = path.join(dir, "pages.json");
    await writeFile(file, "{not json");
    const store = new PageStore(baseUrl, file);
    await store.remember(id, { key });
    expect(await store.get(id)).toEqual({ key });
    const asideNames = (await readdir(dir)).filter((n) => n.startsWith("pages.json.unreadable-"));
    expect(asideNames).toHaveLength(1);
  });
});
