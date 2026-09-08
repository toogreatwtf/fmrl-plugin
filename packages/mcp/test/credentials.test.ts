import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { credentialsPath, readCredentials, writeCredentials } from "../src/credentials.js";

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
  it("returns an empty file when missing or unreadable", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "fmrl-"));
    expect(await readCredentials(path.join(dir, "nope", "credentials.json"))).toEqual({ version: 1, keys: {} });
    const bad = path.join(dir, "bad.json");
    await writeFile(bad, "{not json");
    expect(await readCredentials(bad)).toEqual({ version: 1, keys: {} });
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
});
