import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { alreadyOffered, autoUpdateState, claimOffer, settingsPath, shouldOffer, statePath } from "../src/autoupdate.js";

/** fakeSettings writes settings (as-is when a string) and answers its directory, a CLAUDE_CONFIG_DIR. */
async function fakeSettings(settings: unknown): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "fmrl-settings-"));
  await writeFile(path.join(dir, "settings.json"), typeof settings === "string" ? settings : JSON.stringify(settings));
  return dir;
}

const marketplace = (autoUpdate?: unknown) => ({
  extraKnownMarketplaces: {
    "fmrl-plugin": {
      source: { source: "git", url: "https://github.com/toogreatwtf/fmrl-plugin.git" },
      ...(autoUpdate === undefined ? {} : { autoUpdate }),
    },
  },
});

describe("settingsPath", () => {
  it("is CLAUDE_CONFIG_DIR/settings.json when that is set", () => {
    expect(settingsPath({ CLAUDE_CONFIG_DIR: "/somewhere/cfg" }, () => "/home/x")).toBe(path.join("/somewhere/cfg", "settings.json"));
  });
  it("is ~/.claude/settings.json otherwise", () => {
    expect(settingsPath({}, () => "/home/x")).toBe(path.join("/home/x", ".claude", "settings.json"));
  });
});

describe("autoUpdateState", () => {
  it("is on when the marketplace carries autoUpdate: true", async () => {
    const dir = await fakeSettings(marketplace(true));
    expect(await autoUpdateState({ CLAUDE_CONFIG_DIR: dir }, () => "/home/x")).toEqual({ on: true, file: path.join(dir, "settings.json") });
  });
  it("is off when the marketplace is there without the flag, or with it false", async () => {
    for (const value of [undefined, false]) {
      const dir = await fakeSettings(marketplace(value));
      expect(await autoUpdateState({ CLAUDE_CONFIG_DIR: dir }, () => "/home/x")).toEqual({ on: false, file: path.join(dir, "settings.json") });
    }
  });
  it("says nothing when this marketplace is not the user's: another name, or none at all", async () => {
    for (const settings of [{ extraKnownMarketplaces: { "someone-else": { autoUpdate: true } } }, { extraKnownMarketplaces: {} }, {}]) {
      const dir = await fakeSettings(settings);
      expect(await autoUpdateState({ CLAUDE_CONFIG_DIR: dir }, () => "/home/x")).toBeUndefined();
    }
  });
  it("says nothing when the file is missing, unreadable or not an object", async () => {
    const missing = await mkdtemp(path.join(tmpdir(), "fmrl-settings-"));
    expect(await autoUpdateState({ CLAUDE_CONFIG_DIR: missing }, () => "/home/x")).toBeUndefined();
    for (const junk of ["{ not json", "[]", "null", '"text"']) {
      const dir = await fakeSettings(junk);
      expect(await autoUpdateState({ CLAUDE_CONFIG_DIR: dir }, () => "/home/x")).toBeUndefined();
    }
  });
  it("only true counts as on: a truthy string is not the flag", async () => {
    const dir = await fakeSettings(marketplace("enabled"));
    expect(await autoUpdateState({ CLAUDE_CONFIG_DIR: dir }, () => "/home/x")).toEqual({ on: false, file: path.join(dir, "settings.json") });
  });
});

describe("statePath and the offer marker", () => {
  it("sits beside the credentials file, so one fmrl directory holds both", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "fmrl-state-"));
    expect(statePath({ XDG_CONFIG_HOME: dir }, "darwin", () => "/home/x")).toBe(path.join(dir, "fmrl", "state.json"));
  });
  it("reads as not offered until something claims it, and as offered after", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "fmrl-state-"));
    const file = path.join(dir, "fmrl", "state.json");
    expect(await alreadyOffered(file)).toBe(false);
    await claimOffer(file);
    expect(await alreadyOffered(file)).toBe(true);
  });
  it("reads junk, and a file that is really a directory, as not offered", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "fmrl-state-"));
    const file = path.join(dir, "state.json");
    await writeFile(file, "{ not json");
    expect(await alreadyOffered(file)).toBe(false);
    const blocked = path.join(dir, "blocked", "state.json");
    await mkdir(blocked, { recursive: true });
    expect(await alreadyOffered(blocked)).toBe(false);
  });
});

describe("claimOffer", () => {
  it("is won once: the winner offers, every later start does not", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "fmrl-state-"));
    const file = path.join(dir, "fmrl", "state.json");
    expect(await claimOffer(file)).toBe(true);
    expect(await claimOffer(file)).toBe(false);
  });
  it("is won by exactly one of two starts racing for it", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "fmrl-state-"));
    const file = path.join(dir, "fmrl", "state.json");
    const won = await Promise.all([claimOffer(file), claimOffer(file), claimOffer(file)]);
    expect(won.filter(Boolean)).toHaveLength(1);
  });
  it("keeps what else the file holds, and leaves no litter behind", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "fmrl-state-"));
    const file = path.join(dir, "state.json");
    await writeFile(file, JSON.stringify({ version: 1, somethingElse: "keep me" }));
    expect(await claimOffer(file)).toBe(true);
    const after = JSON.parse(await readFile(file, "utf8"));
    expect(after.somethingElse).toBe("keep me");
    expect(typeof after.autoUpdateOfferedAt).toBe("string");
    expect(await readdir(dir)).toEqual(["state.json"]);
  });
  it("does not claim when it cannot write: a machine that cannot remember is asked again", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "fmrl-state-"));
    const blocked = path.join(dir, "blocked", "state.json");
    await mkdir(blocked, { recursive: true });
    expect(await claimOffer(blocked)).toBe(false);
  });
});

describe("shouldOffer", () => {
  const off = { on: false, file: "/s.json" };
  it("offers once: auto-update off and nothing said yet", () => {
    expect(shouldOffer(off, false)).toBe(true);
  });
  it("does not offer twice on one machine", () => {
    expect(shouldOffer(off, true)).toBe(false);
  });
  it("never offers what is already on, or what it cannot see", () => {
    expect(shouldOffer({ on: true, file: "/s.json" }, false)).toBe(false);
    expect(shouldOffer(undefined, false)).toBe(false);
  });
  it("does not offer when the plugin's own version is unreadable: the notice it would ride in is not sent", () => {
    // pluginStatus undefined means no instructions go out at all, so an
    // offer counted here would be spent on a message nobody sees.
    expect(shouldOffer(off, false, false)).toBe(false);
    expect(shouldOffer(off, false, true)).toBe(true);
  });
});
