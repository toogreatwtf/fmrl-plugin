import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { alreadyOffered, autoUpdatePass, autoUpdateState, claimOffer, settingsPath, shouldOffer, statePath } from "../src/autoupdate.js";

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

describe("autoUpdatePass", () => {
  it("runs in a plain environment: nothing says otherwise", () => {
    expect(autoUpdatePass({})).toEqual({ runs: true, desktop: false });
    expect(autoUpdatePass({ CLAUDE_CODE_ENTRYPOINT: "cli" })).toEqual({ runs: true, desktop: false });
  });
  it("does not run under DISABLE_AUTOUPDATER, which the CLI reads as a flag: 1, true, yes or on", () => {
    for (const value of ["1", "true", "YES", " on "]) {
      expect(autoUpdatePass({ DISABLE_AUTOUPDATER: value }), value).toEqual({ runs: false, desktop: false, by: "DISABLE_AUTOUPDATER" });
    }
    for (const value of ["0", "false", "", "off"]) {
      expect(autoUpdatePass({ DISABLE_AUTOUPDATER: value }), JSON.stringify(value)).toEqual({ runs: true, desktop: false });
    }
  });
  it("does not run under DISABLE_UPDATES or CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, which the CLI reads as set-or-not: even 0 and false count", () => {
    for (const name of ["DISABLE_UPDATES", "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC"]) {
      for (const value of ["1", "0", "false"]) {
        expect(autoUpdatePass({ [name]: value }), `${name}=${value}`).toEqual({ runs: false, desktop: false, by: name });
      }
      expect(autoUpdatePass({ [name]: "" }), `${name}=`).toEqual({ runs: true, desktop: false });
    }
  });
  it("names the first variable the CLI would, in its order", () => {
    expect(autoUpdatePass({ DISABLE_AUTOUPDATER: "1", DISABLE_UPDATES: "1" }).by).toBe("DISABLE_UPDATES");
    expect(autoUpdatePass({ DISABLE_AUTOUPDATER: "1", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" }).by).toBe("DISABLE_AUTOUPDATER");
  });
  it("runs again under FORCE_AUTOUPDATE_PLUGINS, which overrides all three", () => {
    expect(autoUpdatePass({ DISABLE_AUTOUPDATER: "1", FORCE_AUTOUPDATE_PLUGINS: "1" })).toEqual({ runs: true, desktop: false });
  });
  it("names the desktop app when the entrypoint says so and the pass is disabled", () => {
    // The Claude desktop app's Code tab runs its CLI with DISABLE_AUTOUPDATER=1
    // and CLAUDE_CODE_ENTRYPOINT=claude-desktop; the MCP server inherits both.
    expect(autoUpdatePass({ DISABLE_AUTOUPDATER: "1", CLAUDE_CODE_ENTRYPOINT: "claude-desktop" })).toEqual({ runs: false, desktop: true, by: "DISABLE_AUTOUPDATER" });
    // The entrypoint alone is not a disabled pass.
    expect(autoUpdatePass({ CLAUDE_CODE_ENTRYPOINT: "claude-desktop" })).toEqual({ runs: true, desktop: false });
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
  it("does not offer where the auto-update pass cannot run: the switch would do nothing there", () => {
    // Not spending the once-per-machine claim here is index.ts's doing:
    // claimOffer runs only when this says true, so a user who later runs
    // the terminal CLI still gets the one offer there.
    expect(shouldOffer(off, false, true, { runs: false, desktop: true, by: "DISABLE_AUTOUPDATER" })).toBe(false);
    expect(shouldOffer(off, false, true, { runs: false, desktop: false, by: "DISABLE_UPDATES" })).toBe(false);
    expect(shouldOffer(off, false, true, { runs: true, desktop: false })).toBe(true);
    expect(shouldOffer(off, false, true, undefined)).toBe(true);
  });
});
