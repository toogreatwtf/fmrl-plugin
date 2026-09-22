import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { pluginInstructions } from "../src/plugin.js";

// The plugin's own files, read from the repo: the manifest, its skills, and
// the package they ship alongside.
const repo = path.resolve(import.meta.dirname, "../../..");
const read = (p: string) => readFileSync(path.join(repo, p), "utf8");
const manifest = JSON.parse(read("plugins/fmrl/.claude-plugin/plugin.json")) as { version: string; description: string };
const pkg = JSON.parse(read("packages/mcp/package.json")) as { version: string };
const majorMinor = (v: string) => v.split(".").slice(0, 2).join(".");

describe("the plugin manifest", () => {
  it("is in step with fmrl-mcp on major.minor, so the stale check never nags a fresh install", () => {
    expect(majorMinor(manifest.version)).toBe(majorMinor(pkg.version));
  });
  it("names both slash commands", () => {
    expect(manifest.description).toContain("/fmrl:share");
    expect(manifest.description).toContain("/fmrl:whoami");
  });
});

describe("/fmrl:whoami", () => {
  let cached: string | undefined;
  const skillText = () => (cached ??= read("plugins/fmrl/skills/whoami/SKILL.md"));
  it("is a skill named whoami that calls fmrl_whoami", () => {
    expect(skillText()).toMatch(/^---\nname: whoami\ndescription: .+\n---\n/);
    expect(skillText()).toContain("`fmrl_whoami`");
  });
  it("relays the plugin line, and updates only with the user's OK", () => {
    expect(skillText()).toMatch(/plugin line/i);
    expect(skillText()).toContain("claude plugin marketplace update fmrl-plugin");
    expect(skillText()).toContain("claude plugin update fmrl@fmrl-plugin");
    expect(skillText()).toMatch(/only once the user says yes/i);
  });
  it("keeps the link rules /fmrl:share keeps", () => {
    expect(skillText()).toMatch(/Never print the ring on its own/);
    expect(skillText()).toMatch(/Never open the link yourself/);
  });
  it("is what a stale plugin's instructions point to after the restart", () => {
    expect(pluginInstructions({ installed: "0.3.0", server: pkg.version, stale: true })).toContain("/fmrl:whoami");
  });
});
