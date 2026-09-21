import { mkdir, mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { credentialsPath, readCredentials, writeCredentials } from "../src/credentials.js";

/** oneUnreadableFile finds the single `${base}.unreadable-*` sibling readCredentials left behind. */
async function oneUnreadableFile(dir: string, base: string): Promise<string> {
  const names = (await readdir(dir)).filter((n) => n.startsWith(`${base}.unreadable-`));
  expect(names).toHaveLength(1);
  return path.join(dir, names[0]);
}

describe("credentialsPath", () => {
  const home = () => "/home/u";
  it("uses XDG_CONFIG_HOME when set", () => {
    expect(credentialsPath({ XDG_CONFIG_HOME: "/xdg" }, "linux", home)).toBe("/xdg/fmrl/credentials.json");
  });
  it("falls back to ~/.config on linux and darwin", () => {
    expect(credentialsPath({}, "linux", home)).toBe("/home/u/.config/fmrl/credentials.json");
    expect(credentialsPath({ XDG_CONFIG_HOME: "  " }, "darwin", home)).toBe("/home/u/.config/fmrl/credentials.json");
  });
  it("uses APPDATA on windows", () => {
    expect(credentialsPath({ APPDATA: "C:\\Users\\u\\AppData\\Roaming" }, "win32", home)).toBe(
      path.win32.join("C:\\Users\\u\\AppData\\Roaming", "fmrl", "credentials.json"),
    );
  });
});

describe("read and write", () => {
  it("returns an empty file when missing; moves an unreadable one aside instead of destroying it", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "fmrl-"));
    expect(await readCredentials(path.join(dir, "nope", "credentials.json"))).toEqual({ version: 1, keys: {} });
    const bad = path.join(dir, "bad.json");
    const original = "{not json";
    await writeFile(bad, original);
    expect(await readCredentials(bad)).toEqual({ version: 1, keys: {} });
    const aside = await oneUnreadableFile(dir, "bad.json");
    expect(await readFile(aside, "utf8")).toBe(original);
    await expect(stat(bad)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("moves a wrong-version file aside the same way", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "fmrl-"));
    const file = path.join(dir, "credentials.json");
    const original = JSON.stringify({ version: 2, keys: {} });
    await writeFile(file, original);
    expect(await readCredentials(file)).toEqual({ version: 1, keys: {} });
    const aside = await oneUnreadableFile(dir, "credentials.json");
    expect(await readFile(aside, "utf8")).toBe(original);
    await expect(stat(file)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("logs the aside path and never the ring when moving a file aside", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "fmrl-"));
    const file = path.join(dir, "credentials.json");
    const ring = "R".repeat(43);
    await writeFile(file, JSON.stringify({ version: 1, keys: { x: { key: "fmrl_x", prefix: "fmrl_x", created_at: "t", ring } }, rings: { fmrl_old1: ring } }) + ",");
    const logs: string[] = [];
    await readCredentials(file, (line) => logs.push(line));
    const aside = await oneUnreadableFile(dir, "credentials.json");
    const joined = logs.join("\n");
    expect(joined).toContain(`fmrl-mcp: couldn't read ${file} (`);
    expect(joined).toContain(aside);
    expect(joined).not.toContain(ring);
  });
  it("preserves an unknown top-level field across a read, write, read", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "fmrl-"));
    const file = path.join(dir, "credentials.json");
    await writeFile(file, JSON.stringify({ version: 1, keys: {}, futureField: "kept" }));
    const read = await readCredentials(file);
    expect((read as unknown as { futureField: string }).futureField).toBe("kept");
    await writeCredentials(file, read);
    const reread = await readCredentials(file);
    expect((reread as unknown as { futureField: string }).futureField).toBe("kept");
  });
  it("writes atomically with 0600 and creates the directory with 0700", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "fmrl-"));
    const file = path.join(dir, "cfg", "fmrl", "credentials.json");
    const data = { version: 1 as const, keys: { "https://fmrl.site": { key: "fmrl_x", prefix: "fmrl_x", created_at: "2026-09-08T00:00:00Z" } } };
    await writeCredentials(file, data);
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual(data);
    if (process.platform !== "win32") {
      expect((await stat(file)).mode & 0o777).toBe(0o600);
      expect((await stat(path.dirname(file))).mode & 0o777).toBe(0o700);
    }
    expect(await readCredentials(file)).toEqual(data);
    // No temp file left behind.
    const { readdir } = await import("node:fs/promises");
    expect(await readdir(path.dirname(file))).toEqual(["credentials.json"]);
  });
  it("tightens an already-existing directory's permissions to 0700", async () => {
    if (process.platform === "win32") return;
    const dir = await mkdtemp(path.join(tmpdir(), "fmrl-"));
    const credDir = path.join(dir, "fmrl");
    await mkdir(credDir, { recursive: true, mode: 0o755 });
    const file = path.join(credDir, "credentials.json");
    const data = { version: 1 as const, keys: {} };
    await writeCredentials(file, data);
    expect((await stat(credDir)).mode & 0o777).toBe(0o700);
  });
  it("keeps a key's ring and the rings map, and drops a malformed entry from the map", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "fmrl-"));
    const file = path.join(dir, "credentials.json");
    const data = {
      version: 1 as const,
      keys: { "https://fmrl.site": { key: "fmrl_x", prefix: "fmrl_x", created_at: "2026-09-08T00:00:00Z", ring: "R".repeat(43) } },
      rings: { fmrl_old1: "O".repeat(43) },
    };
    await writeCredentials(file, data);
    expect(await readCredentials(file)).toEqual(data);
    await writeFile(file, JSON.stringify({ ...data, rings: { fmrl_bad1: "short", fmrl_bad2: 7, fmrl_ok11: "K".repeat(43) } }));
    expect((await readCredentials(file)).rings).toEqual({ fmrl_ok11: "K".repeat(43) });
    for (const rings of ["nope", null]) {
      await writeFile(file, JSON.stringify({ version: 1, keys: {}, rings }));
      expect(await readCredentials(file)).toEqual({ version: 1, keys: {} });
    }
  });
});
