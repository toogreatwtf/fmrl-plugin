import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { pluginInstructions } from "../src/plugin.js";
import { readProfile } from "../src/profile.js";

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
  it("names every tool, as the READMEs' tables do", () => {
    const tools = ["fmrl_publish", "fmrl_publish_file", "fmrl_get", "fmrl_edit", "fmrl_watch", "fmrl_inbox", "fmrl_list", "fmrl_delete", "fmrl_whoami", "fmrl_redeem", "fmrl_rotate"];
    for (const t of tools) {
      expect(manifest.description).toContain(`${t}`);
      for (const readme of ["README.md", "packages/mcp/README.md"]) expect(read(readme)).toContain(`| \`${t}\` |`);
    }
    expect(read("README.md")).toContain("Any MCP client gets eleven tools:");
    expect(read("packages/mcp/README.md")).toContain("Any MCP client gets eleven tools:");
  });
  it("names both slash commands", () => {
    expect(manifest.description).toContain("/fmrl:share");
    expect(manifest.description).toContain("/fmrl:whoami");
  });
});

describe("the READMEs' keep-current paragraph", () => {
  const sentence = "In the Claude desktop app the switch does nothing: update by hand, or when the plugin says it is out of date.";
  it("says the switch does nothing in the Claude desktop app, in both READMEs and in the same paragraph", () => {
    for (const file of ["README.md", "packages/mcp/README.md"]) {
      const line = read(file).split("\n").find((l) => l.startsWith("Keep it current: auto-update is your switch"));
      expect(line, file).toContain(sentence);
    }
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
  it("does not offer the switch where the line says auto-update does not run", () => {
    // The Claude desktop app (and a CLI with the auto-updater disabled)
    // never runs the plugin auto-update pass; there the line says so
    // instead of reporting the switch, and the commands are the way.
    expect(skillText()).toMatch(/auto-update does not run/i);
  });
  it("keeps account guidance optional and private-key backup distinct", () => {
    expect(skillText()).toContain("If sign-in is available there");
    expect(skillText()).toContain("back up the named credentials file");
    expect(skillText()).toContain("No plugin line means version information is unavailable");
    expect(skillText()).toContain("Codex: use Codex's plugin settings; never give Claude CLI commands");
    expect(skillText()).toContain("including its complete `#r=` fragment");
  });
  it("requires explicit vault fingerprint confirmation and retains recovery advice", () => {
    const whoamiSkill = skillText();
    expect(whoamiSkill).toContain("trust_vault");
    expect(whoamiSkill).toContain("explicitly");
    expect(whoamiSkill).toContain("fingerprint");
    expect(whoamiSkill).not.toContain("Signing in does not back up private-page keys.");
  });
  it("keeps the link rules /fmrl:share keeps", () => {
    expect(skillText()).toMatch(/Never print the ring on its own/);
    expect(skillText()).toMatch(/Never open the link yourself/);
  });
  it("is what a stale plugin's instructions point to after the restart", () => {
    expect(pluginInstructions({ installed: "0.3.0", server: pkg.version, stale: true }, undefined, undefined, "claude-cli")).toContain("/fmrl:whoami");
  });
});

describe("/fmrl:share and the handoff-review starter", () => {
  const starter = () => read("plugins/fmrl/skills/share/handoff-review.md");
  const share = () => read("plugins/fmrl/skills/share/SKILL.md");
  it("ships the starter, whose profile names the eight sections in order and finds a heading for each", () => {
    const r = readProfile(starter(), "md");
    expect(r.profile_error).toBeUndefined();
    expect(r.profile?.profile).toBe("handoff-review");
    expect(r.profile?.sections.map((s) => s.id)).toEqual(
      ["header", "what-changed", "review-map", "decisions", "evidence", "deviations", "questions", "context-gaps"]);
    expect(r.profile?.sections.every((s) => s.purpose.length > 0)).toBe(true);
    expect(r.profile?.norms).toContain("evidence is a results table, not a transcript");
    expect(r.missing).toEqual([]);
  });
  it("offers it when a handoff canvas starts, and names the house page", () => {
    expect(share()).toContain("handoff-review.md");
    expect(share()).toContain("https://fmrl.site/h4ndrv");
    expect(share()).toMatch(/fmrl-profile/);
  });
});
