import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { pluginInstructions, pluginLine, pluginStatus } from "../src/plugin.js";

/** fakeRoot is a CLAUDE_PLUGIN_ROOT whose .claude-plugin/plugin.json holds manifest (written as-is when a string). */
async function fakeRoot(manifest: unknown): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "fmrl-plugin-"));
  await mkdir(path.join(root, ".claude-plugin"));
  await writeFile(path.join(root, ".claude-plugin", "plugin.json"), typeof manifest === "string" ? manifest : JSON.stringify(manifest));
  return root;
}

describe("pluginStatus", () => {
  it("a 0.3.x plugin under a 0.5.1 server is stale", async () => {
    const root = await fakeRoot({ name: "fmrl", version: "0.3.0" });
    expect(pluginStatus(root, "0.5.1")).toEqual({ installed: "0.3.0", server: "0.5.1", stale: true });
  });
  it("a 0.5.0 plugin under a 0.5.1 server is current: patch releases never nag", async () => {
    const root = await fakeRoot({ name: "fmrl", version: "0.5.0" });
    expect(pluginStatus(root, "0.5.1")).toEqual({ installed: "0.5.0", server: "0.5.1", stale: false });
  });
  it("an older major is stale; a plugin ahead of the server is not", async () => {
    expect(pluginStatus(await fakeRoot({ version: "0.9.4" }), "1.0.0")?.stale).toBe(true);
    expect(pluginStatus(await fakeRoot({ version: "0.6.0" }), "0.5.1")?.stale).toBe(false);
    expect(pluginStatus(await fakeRoot({ version: "1.0.0" }), "0.9.9")?.stale).toBe(false);
  });
  it("no CLAUDE_PLUGIN_ROOT says nothing", () => {
    expect(pluginStatus(undefined, "0.5.1")).toBeUndefined();
    expect(pluginStatus("", "0.5.1")).toBeUndefined();
  });
  it("a missing, malformed or odd plugin.json says nothing", async () => {
    expect(pluginStatus(await mkdtemp(path.join(tmpdir(), "fmrl-plugin-")), "0.5.1")).toBeUndefined();
    expect(pluginStatus(await fakeRoot("{ not json"), "0.5.1")).toBeUndefined();
    expect(pluginStatus(await fakeRoot({ name: "fmrl" }), "0.5.1")).toBeUndefined();
    expect(pluginStatus(await fakeRoot({ version: 5 }), "0.5.1")).toBeUndefined();
    expect(pluginStatus(await fakeRoot({ version: "latest" }), "0.5.1")).toBeUndefined();
    expect(pluginStatus(await fakeRoot("null"), "0.5.1")).toBeUndefined();
  });
  it("a version that is not strict SemVer says nothing", async () => {
    for (const version of ["0.3.0-", "0.3.0+", "0.3.0-?", "0.3.0-a..b", "0.3.0\n", "00.3.0", "0.3"]) {
      expect(pluginStatus(await fakeRoot({ version }), "0.5.1"), JSON.stringify(version)).toBeUndefined();
    }
  });
  it("prerelease and build suffixes compare on major.minor", async () => {
    expect(pluginStatus(await fakeRoot({ version: "0.3.0-rc.1+build.5" }), "0.5.1")?.stale).toBe(true);
    expect(pluginStatus(await fakeRoot({ version: "0.5.0-beta" }), "0.5.1")?.stale).toBe(false);
  });
  it("an odd server version says nothing", async () => {
    expect(pluginStatus(await fakeRoot({ version: "0.3.0" }), "dev")).toBeUndefined();
  });
});

describe("pluginInstructions", () => {
  const stale = { installed: "0.3.0", server: "0.5.1", stale: true };
  it("is empty unless the plugin is stale", () => {
    expect(pluginInstructions(undefined)).toBeUndefined();
    expect(pluginInstructions({ installed: "0.5.0", server: "0.5.1", stale: false })).toBeUndefined();
  });
  it("names both versions as major.minor and asks for one mention, after the user's request", () => {
    const t = pluginInstructions(stale)!;
    expect(t).toContain("installed 0.3, fmrl-mcp is at 0.5");
    expect(t).toMatch(/once per session/);
    expect(t).toMatch(/after you have finished the user's current request/);
  });
  it("runs the two update commands only with the user's OK, then says to restart", () => {
    const t = pluginInstructions(stale)!;
    expect(t).toContain("claude plugin marketplace update fmrl-plugin");
    expect(t).toContain("claude plugin update fmrl@fmrl-plugin");
    expect(t.indexOf("claude plugin marketplace update fmrl-plugin")).toBeLessThan(t.indexOf("claude plugin update fmrl@fmrl-plugin"));
    expect(t).toMatch(/only once the user says yes/i);
    expect(t).toMatch(/restart Claude Code/);
  });
  it("gives the in-app steps when it cannot run them", () => {
    const t = pluginInstructions(stale)!;
    expect(t).toContain("/plugin marketplace update fmrl-plugin");
    expect(t).toContain("/plugin → Installed → fmrl → Update now");
    expect(t).toContain("Settings → Plugins → Fmrl → Update");
  });
  it("never has the agent edit plugin files, and says nothing about auto-update it cannot know", () => {
    // Without the user's settings there is no telling whether auto-update
    // is already on, and telling someone to turn on a switch they have had
    // on for months is how this notice loses its credibility. The switch is
    // named only when the settings say it is off (see "the auto-update
    // offer" below).
    const t = pluginInstructions(stale)!;
    expect(t).toContain("Never edit files under ~/.claude/plugins");
    expect(t).not.toContain("Enable auto-update");
  });
});

describe("pluginLine", () => {
  it("says nothing without a status", () => {
    expect(pluginLine(undefined)).toBeUndefined();
  });
  it("a stale plugin: both versions and how to fix it", () => {
    expect(pluginLine({ installed: "0.3.0", server: "0.5.1", stale: true })).toBe(
      "The fmrl plugin is out of date: installed 0.3, fmrl-mcp is at 0.5. Update it with `claude plugin marketplace update fmrl-plugin` then `claude plugin update fmrl@fmrl-plugin`, and restart Claude Code. /plugin → Marketplaces → fmrl-plugin → Enable auto-update keeps it current.",
    );
  });
  it("a current plugin says so", () => {
    expect(pluginLine({ installed: "0.5.0", server: "0.5.1", stale: false })).toBe("The fmrl plugin is up to date (plugin 0.5.0, fmrl-mcp 0.5.1).");
  });
});

describe("the auto-update offer", () => {
  const settings = "/home/x/.claude/settings.json";
  const current = { installed: "0.6.0", server: "0.6.0", stale: false };
  const stale = { installed: "0.5.0", server: "0.6.0", stale: true };

  it("is made when the plugin is current but auto-update is off", () => {
    const out = pluginInstructions(current, { on: false, file: settings }) ?? "";
    expect(out).toContain("auto-update");
    expect(out).toContain(settings);
    expect(out).toContain("extraKnownMarketplaces");
    expect(out).toContain("fmrl-plugin");
    // It is the user's switch and their file: consent first, and it is not
    // a thing that takes effect this session.
    expect(out).toMatch(/only once the user says yes|once they say yes/i);
    expect(out).toMatch(/next [\w ]*start|restart/i);
    // Nothing to update: this is not the stale nag.
    expect(out).not.toContain("out of date");
  });

  it("is not made when auto-update is already on, nor when the settings say nothing", () => {
    expect(pluginInstructions(current, { on: true, file: settings })).toBeUndefined();
    expect(pluginInstructions(current, undefined)).toBeUndefined();
  });

  it("is not made at all without a plugin: another client's server says nothing", () => {
    expect(pluginInstructions(undefined, { on: false, file: settings })).toBeUndefined();
  });

  it("rides along with the stale nag rather than arriving as a second message", () => {
    const out = pluginInstructions(stale, { on: false, file: settings }) ?? "";
    expect(out).toContain("out of date");
    expect(out).toContain(settings);
    expect(out.match(/^The fmrl plugin/gm)?.length).toBe(1);
  });

  it("leaves the stale nag alone when auto-update is already on: nothing to turn on", () => {
    const out = pluginInstructions(stale, { on: true, file: settings }) ?? "";
    expect(out).toContain("out of date");
    expect(out).not.toContain("Enable auto-update");
    expect(out).not.toContain(settings);
  });
});

describe("pluginLine and auto-update", () => {
  const current = { installed: "0.6.0", server: "0.6.0", stale: false };
  it("says auto-update is keeping it current when it is on", () => {
    const line = pluginLine(current, { on: true, file: "/s.json" }) ?? "";
    expect(line).toContain("up to date");
    expect(line).toMatch(/auto-update is on/i);
  });
  it("says it is not being kept current when the switch is off, and where the switch is", () => {
    const line = pluginLine(current, { on: false, file: "/s.json" }) ?? "";
    expect(line).toMatch(/auto-update is off/i);
    expect(line).toContain("/plugin → Marketplaces → fmrl-plugin → Enable auto-update");
  });
  it("says nothing about a switch it cannot see", () => {
    const line = pluginLine(current) ?? "";
    expect(line).toContain("up to date");
    expect(line).not.toMatch(/auto-update/i);
  });
});
