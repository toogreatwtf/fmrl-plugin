import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// plugins/fmrl-chatgpt is the package OpenAI's plugin portal takes. The
// portal refuses a package on these limits (developers.openai.com/plugins,
// "Submission errors"), so a refusal shows up here first.
const repo = path.resolve(import.meta.dirname, "../../..");
const dir = path.join(repo, "plugins/fmrl-chatgpt");
const read = (p: string) => readFileSync(path.join(dir, p), "utf8");
const manifest = JSON.parse(read("plugin.json"));
const openai = manifest.extensions["com.openai"];
const ui = openai.interface;
const cases = openai.review.test_cases;
const mcp = JSON.parse(read("mcp.json"));

// The hosted server's tools (markymd internal/handler/mcp_tools.go). The
// local-only ones are named so the package never promises them.
const hosted = ["fmrl_publish", "fmrl_get", "fmrl_watch", "fmrl_inbox", "fmrl_edit", "fmrl_list", "fmrl_whoami", "fmrl_delete"];
const localOnly = ["fmrl_publish_file", "fmrl_status", "fmrl_redeem", "fmrl_rotate", "manage_token", "#p="];

const files = (d: string): string[] =>
  readdirSync(d).flatMap((f) => (statSync(path.join(d, f)).isDirectory() ? files(path.join(d, f)) : [path.join(d, f)]));
const texts = files(dir).filter((f) => /\.(md|json)$/.test(f) && !f.endsWith("README.md"));

const luminance = (hex: string) => {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
};
const contrast = (a: string, b: string) => {
  const [x, y] = [luminance(a), luminance(b)].sort((m, n) => n - m);
  return (x + 0.05) / (y + 0.05);
};
const png = (p: string) => {
  const b = readFileSync(path.join(dir, p));
  expect(b.subarray(1, 4).toString()).toBe("PNG");
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20), size: b.length };
};

describe("the ChatGPT manifest", () => {
  it("is an Agent Plugins manifest with a valid name, semver and author", () => {
    expect(manifest.$schema).toBe("https://agent-plugins.org/schemas/1.0.0/plugin.schema.json");
    expect(manifest.name).toMatch(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/);
    expect(manifest.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(manifest.description.length).toBeLessThanOrEqual(1024);
    expect(manifest.author.name.length).toBeLessThanOrEqual(120);
  });
  it("keeps the listing inside the portal's limits", () => {
    expect(ui.displayName.length).toBeLessThanOrEqual(30);
    expect(ui.displayName).not.toMatch(/\b(MCP|Plugin)\b/i);
    expect(ui.shortDescription.length).toBeLessThanOrEqual(30);
    expect(ui.shortDescription).not.toContain("\n");
    expect(ui.longDescription.length).toBeLessThanOrEqual(4000);
    expect(ui.developerName.length).toBeLessThanOrEqual(80);
    expect(ui.category).toBeTruthy();
    expect(ui.capabilities.length).toBeLessThanOrEqual(20);
    for (const c of ui.capabilities) expect(c.length).toBeLessThanOrEqual(120);
    expect(ui.defaultPrompt.length).toBeLessThanOrEqual(3);
    expect(new Set(ui.defaultPrompt).size).toBe(ui.defaultPrompt.length);
    for (const p of ui.defaultPrompt) {
      expect(p.length).toBeLessThanOrEqual(128);
      expect(p).not.toContain("@");
    }
  });
  it("links fmrl's own site, support, privacy and terms pages", () => {
    expect(ui.websiteURL).toBe("https://fmrl.site");
    expect(ui.supportURL).toBe("https://fmrl.site/support");
    expect(ui.privacyPolicyURL).toBe("https://fmrl.site/privacy");
    expect(ui.termsOfServiceURL).toBe("https://fmrl.site/terms");
  });
  it("has brand colours with at least 2:1 contrast on white and on #212121", () => {
    expect(ui.brandColor).toMatch(/^#[0-9A-Fa-f]{6}$/);
    expect(contrast(ui.brandColor, "#FFFFFF")).toBeGreaterThanOrEqual(2);
    expect(contrast(ui.brandColorDark, "#212121")).toBeGreaterThanOrEqual(2);
  });
  it("ships square PNG icons of at least 48 px under ./assets", () => {
    for (const p of [ui.logo, ui.composerIcon]) {
      expect(p).toMatch(/^\.\/assets\//);
      const { w, h, size } = png(p);
      expect(w).toBe(h);
      expect(w).toBeGreaterThanOrEqual(48);
      expect(w).toBeLessThanOrEqual(4096);
      expect(size).toBeLessThan(5 * 1024 * 1024);
    }
    expect(ui.screenshots).toBeUndefined(); // only for servers with custom UI
  });
  it("has five positive and three negative review cases, using hosted tools only", () => {
    expect(cases.positive).toHaveLength(5);
    expect(cases.negative).toHaveLength(3);
    for (const c of cases.positive) {
      for (const k of ["description", "prompt", "tools_triggered", "expected_behavior"]) expect(c[k], k).toBeTruthy();
      for (const t of c.tools_triggered.split(",").map((s: string) => s.trim())) expect(hosted).toContain(t);
    }
    for (const c of cases.negative) for (const k of ["description", "prompt"]) expect(c[k], k).toBeTruthy();
    expect(openai.review.commerce).toBe(false);
    expect(openai.review.commerce_description).toBeTruthy();
    expect(openai.publication.release_notes).toBeTruthy();
  });
  it("carries no reviewer credentials", () => {
    expect(openai.review.test_credentials).toBeUndefined();
    expect(openai.review.reviewer_instructions).toBeUndefined();
  });
});

describe("the ChatGPT MCP config", () => {
  it("is the one hosted server over streamable HTTP, OAuth by metadata document, no headers", () => {
    expect(Object.keys(mcp.mcpServers)).toEqual(["fmrl"]);
    const s = mcp.mcpServers.fmrl;
    expect(s.type).toBe("streamable-http");
    expect(s.url).toBe("https://fmrl.site/mcp");
    expect(s.headers).toBeUndefined();
    expect(s.extensions["com.openai"].auth).toEqual({ type: "oauth", client: { mode: "cimd" } });
  });
});

describe("the ChatGPT skills", () => {
  const skills = readdirSync(path.join(dir, "skills"));
  it("are skills/<name>/SKILL.md with a name and a short description", () => {
    expect(skills.length).toBeGreaterThan(0);
    for (const s of skills) {
      expect(s.startsWith(".")).toBe(false);
      const text = read(`skills/${s}/SKILL.md`);
      const front = /^---\nname: (.+)\ndescription: (.+)\n---\n([\s\S]+)$/.exec(text);
      expect(front, s).not.toBeNull();
      expect(front![1]).toBe(s);
      expect(front![2].length).toBeLessThanOrEqual(1024);
      expect(front![3].trim().length).toBeGreaterThan(0);
      expect(`${manifest.name}:${s}`.length).toBeLessThanOrEqual(64);
    }
  });
  it("name every hosted tool they use, and none the hosted server lacks", () => {
    const share = read("skills/share/SKILL.md");
    for (const t of ["fmrl_publish", "fmrl_get", "fmrl_edit", "fmrl_watch", "fmrl_inbox", "fmrl_list", "fmrl_delete", "fmrl_whoami"]) expect(share).toContain(t);
  });
});

describe("the whole ChatGPT package", () => {
  it("names no other assistant and no local-only tool", () => {
    for (const f of texts) {
      const text = readFileSync(f, "utf8");
      expect(text, f).not.toMatch(/\bClaude\b|Anthropic|slash command|\/fmrl:/);
      for (const t of localOnly) expect(text, `${f}: ${t}`).not.toContain(t);
    }
  });
});
