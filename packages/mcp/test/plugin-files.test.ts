import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseFragment, type DefaultTreeAdapterMap } from "parse5";
import { toHTML } from "../src/markdown.js";
import { pluginInstructions, pluginStatus } from "../src/plugin.js";
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
    const tools = ["fmrl_publish", "fmrl_publish_file", "fmrl_get", "fmrl_edit", "fmrl_watch", "fmrl_inbox", "fmrl_list", "fmrl_delete", "fmrl_whoami", "fmrl_status", "fmrl_redeem", "fmrl_rotate"];
    for (const t of tools) {
      expect(manifest.description).toContain(`${t}`);
      for (const readme of ["README.md", "packages/mcp/README.md"]) expect(read(readme)).toContain(`| \`${t}\` |`);
    }
    expect(read("README.md")).toContain("Any MCP client gets twelve tools:");
    expect(read("packages/mcp/README.md")).toContain("Any MCP client gets twelve tools:");
  });
  it("names all three slash commands, as the READMEs do", () => {
    for (const cmd of ["/fmrl:share", "/fmrl:whoami", "/fmrl:status"]) {
      expect(manifest.description).toContain(cmd);
      for (const readme of ["README.md", "packages/mcp/README.md"]) expect(read(readme), readme).toContain(`\`${cmd}\``);
    }
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
    expect(skillText()).toContain("Relay the supplied attach link unchanged");
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

describe("/fmrl:status", () => {
  let cached: string | undefined;
  const skillText = () => (cached ??= read("plugins/fmrl/skills/status/SKILL.md"));
  it("is a skill named status, taking an optional verbose argument, that calls fmrl_status once", () => {
    expect(skillText()).toMatch(/^---\nname: status\ndescription: .+\nargument-hint: \[verbose\]\n---\n/);
    expect(skillText()).toContain("`fmrl_status`");
    expect(skillText()).toMatch(/once/);
    expect(skillText()).toContain("`verbose: true`");
  });
  it("relays the result unchanged, with no other tool and no shell", () => {
    expect(skillText()).toMatch(/unchanged/);
    expect(skillText()).toMatch(/no other tool/i);
    expect(skillText()).toMatch(/shell/i);
  });
  it("says what to do when the tool is missing, and when a second fmrl server is connected", () => {
    expect(skillText()).toContain("/mcp");
    expect(skillText()).toMatch(/not connected/i);
    expect(skillText()).toMatch(/second fmrl/i);
  });
  it("never mints, updates, or prints a key", () => {
    expect(skillText()).toMatch(/Never mint/i);
    expect(skillText()).toMatch(/Never (update|run the update)/i);
    expect(skillText()).toMatch(/Never print/i);
    expect(skillText()).toMatch(/Never edit installed plugin caches/);
  });
});

describe("/fmrl:share and the handoff-review starter", () => {
  const starter = () => read("plugins/fmrl/skills/share/handoff-review.md");
  const share = () => read("plugins/fmrl/skills/share/SKILL.md");
  it("distributes the share skill from the marketplace plugin source", () => {
    const marketplace = JSON.parse(read(".claude-plugin/marketplace.json"));
    const plugin = marketplace.plugins.find((p: { name: string }) => p.name === "fmrl");
    expect(read(path.join(plugin.source, "skills/share/SKILL.md"))).toBe(share());
  });
  it("keeps the documented link examples usable as inline HTML in Markdown", () => {
    const examples = [...share().matchAll(/```html\n([\s\S]*?)```/g)];
    expect(examples.length).toBeGreaterThan(0);
    const nodes: DefaultTreeAdapterMap["element"][] = [];
    const visit = (node: DefaultTreeAdapterMap["node"]) => {
      if ("tagName" in node) nodes.push(node);
      if ("childNodes" in node) node.childNodes.forEach(visit);
    };
    visit(parseFragment(toHTML(examples.map((m) => m[1]).join("\n"))));
    const attr = (node: DefaultTreeAdapterMap["element"], name: string) =>
      node.attrs.find((a) => a.name === name)?.value;
    const links = nodes.filter((node) => node.tagName === "a");
    expect(links).toHaveLength(3);
    for (const link of links) {
      const href = attr(link, "href")!;
      if (href.startsWith("#")) {
        expect(attr(link, "target")).toBe("_self");
        expect(nodes.some((node) => attr(node, "id") === href.slice(1))).toBe(true);
      } else {
        expect(new URL(href).protocol).toBe("https:");
        expect(attr(link, "target")).toBe("_blank");
        expect(attr(link, "rel")?.split(/\s+/)).toEqual(expect.arrayContaining(["noopener", "noreferrer"]));
      }
    }
  });
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

// Cursor installs the same plugin folder from .cursor-plugin/marketplace.json:
// its own manifest and mcp.json, and the skills/ Claude Code reads. These
// hold the rules Cursor's plugin template validates (cursor/plugin-template,
// scripts/validate-template.mjs) and keep the two installs in step.
describe("the Cursor plugin", () => {
  const kebab = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/;
  const marketplace = () => JSON.parse(read(".cursor-plugin/marketplace.json")) as {
    name: string; owner: { name: string }; plugins: { name: string; source: string }[];
  };
  const entry = () => marketplace().plugins.find((p) => p.name === "fmrl")!;
  const cursorManifest = () => JSON.parse(read("plugins/fmrl/.cursor-plugin/plugin.json")) as { name: string; version: string; description: string };
  const servers = (p: string) => (JSON.parse(read(p)) as { mcpServers: Record<string, { command: string; args: string[]; env?: Record<string, string> }> }).mcpServers;

  it("has a marketplace Cursor can import, naming the plugin folder Claude Code installs", () => {
    const m = marketplace();
    expect(m.name).toMatch(kebab);
    expect(m.owner.name.length).toBeGreaterThan(0);
    expect(new Set(m.plugins.map((p) => p.name)).size).toBe(m.plugins.length);
    const source = entry().source;
    expect(path.isAbsolute(source)).toBe(false);
    expect(path.posix.normalize(source).startsWith("..")).toBe(false);
    const claude = JSON.parse(read(".claude-plugin/marketplace.json")).plugins.find((p: { name: string }) => p.name === "fmrl");
    expect(path.resolve(repo, source)).toBe(path.resolve(repo, claude.source));
    expect(existsSync(path.join(repo, source, ".cursor-plugin/plugin.json"))).toBe(true);
  });
  it("has a manifest with the entry's name and the Claude manifest's exact version", () => {
    expect(cursorManifest().name).toBe(entry().name);
    expect(cursorManifest().name).toMatch(kebab);
    expect(cursorManifest().version).toBe(manifest.version);
  });
  it("names every tool, as the Claude manifest does", () => {
    for (const t of ["fmrl_publish", "fmrl_publish_file", "fmrl_get", "fmrl_edit", "fmrl_watch", "fmrl_inbox", "fmrl_list", "fmrl_delete", "fmrl_whoami", "fmrl_status", "fmrl_redeem", "fmrl_rotate"]) {
      expect(cursorManifest().description).toContain(t);
    }
  });
  it("starts the same server as .mcp.json, pointing it at the installed plugin", () => {
    const cursor = servers("plugins/fmrl/mcp.json").fmrl;
    const claude = servers("plugins/fmrl/.mcp.json").fmrl;
    expect(cursor.command).toBe(claude.command);
    expect(cursor.args).toEqual(claude.args);
    // Cursor expands CURSOR_PLUGIN_ROOT in env values; fmrl-mcp reads the
    // plugin's version from CLAUDE_PLUGIN_ROOT/.claude-plugin/plugin.json.
    expect(cursor.env).toEqual({ CLAUDE_PLUGIN_ROOT: "${CURSOR_PLUGIN_ROOT}" });
    expect(pluginStatus(path.join(repo, "plugins/fmrl"), pkg.version)).toEqual({ installed: manifest.version, server: pkg.version, stale: false });
  });
  it("has skills Cursor accepts: a name matching the folder, and a description", () => {
    const skills = readdirSync(path.join(repo, "plugins/fmrl/skills"));
    expect(skills.sort()).toEqual(["share", "status", "whoami"]);
    for (const name of skills) {
      const front = /^---\nname: (.+)\ndescription: (.+)\n/.exec(read(`plugins/fmrl/skills/${name}/SKILL.md`));
      expect(front?.[1], name).toBe(name);
      expect(front?.[1]).toMatch(/^[a-z0-9-]+$/);
      expect(front?.[2].length, name).toBeGreaterThan(0);
    }
  });
  it("is in both READMEs' install steps, and in the skills' client guidance", () => {
    for (const readme of ["README.md", "packages/mcp/README.md"]) expect(read(readme), readme).toContain("From GitHub Repository with `toogreatwtf/fmrl-plugin`");
    expect(read("plugins/fmrl/skills/whoami/SKILL.md")).toContain("Cursor: use the plugin's entry under Cursor's Customize; never give Claude CLI commands");
    expect(read("plugins/fmrl/skills/status/SKILL.md")).toContain("In Cursor, Customize shows whether the fmrl server is on");
  });
});
