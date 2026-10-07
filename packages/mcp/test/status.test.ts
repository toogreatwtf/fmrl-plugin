import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ago, newestCachedPlugin, statusText, upFor, type StatusSnapshot } from "../src/status.js";

const NOW = Date.parse("2026-10-07T12:00:00Z");
const FILE = "/home/me/.config/fmrl/credentials.json";
const base: StatusSnapshot = {
  server: "0.14.0",
  upMs: (2 * 60 + 13) * 60_000,
  client: { name: "claude-code", version: "2.1.284" },
  surface: "claude-cli",
  pluginRoot: "/home/me/.claude/plugins/cache/fmrl-plugin/fmrl/0.14.0",
  pluginLine: "The fmrl plugin is up to date (plugin 0.14.0, fmrl-mcp 0.14.0). Auto-update is on for its marketplace.",
  baseUrl: "https://fmrl.site",
  key: { prefix: "fmrl_K7QX", source: "file", file: FILE, createdAt: "2026-09-21T23:43:00Z", ring: "file" },
  pages: 3,
  lastCall: { method: "GET", path: "/me", status: 200, ms: 212, at: NOW - 4 * 60_000 },
  now: NOW,
};
const lines = (s: StatusSnapshot) => statusText(s).split("\n");

describe("statusText", () => {
  it("is five lines: server, plugin, key, last call, and what verbose would add", () => {
    expect(lines(base)).toEqual([
      "fmrl-mcp 0.14.0, up 2 h 13 min, launched by claude-code 2.1.284 (Claude Code CLI).",
      "The fmrl plugin is up to date (plugin 0.14.0, fmrl-mcp 0.14.0). Auto-update is on for its marketplace.",
      `API https://fmrl.site: key fmrl_K7QX… from ${FILE}, minted 2026-09-21; key ring in that file; 3 pages remembered.`,
      "Last call: GET /me → 200 in 212 ms, 4 min ago.",
      "Network checks skipped: /fmrl:status verbose adds reachability, quota, inbox and npm.",
    ]);
  });
  it("names the launcher by surface, and says so when the client is unknown", () => {
    expect(lines({ ...base, surface: "claude-desktop" })[0]).toContain("launched by claude-code 2.1.284 (the Claude desktop app).");
    expect(lines({ ...base, surface: "codex", client: { name: "codex", version: "1.2" } })[0]).toContain("launched by codex 1.2 (Codex).");
    expect(lines({ ...base, surface: "unknown" })[0]).toMatch(/launched by claude-code 2\.1\.284\.$/);
    expect(lines({ ...base, client: undefined })[0]).toContain("launched by an unknown client");
  });
  it("says when a newer plugin is already installed beside this session's", () => {
    expect(lines({ ...base, newerCached: "0.15.0", installed: "0.14.0" })[1]).toBe(
      "The fmrl plugin is up to date (plugin 0.14.0, fmrl-mcp 0.14.0). Auto-update is on for its marketplace. Plugin 0.15.0 is already installed, but this session started on 0.14.0: restart Claude Code to load it.",
    );
  });
  it("distinguishes no plugin at all from a manifest it could not read", () => {
    expect(lines({ ...base, pluginRoot: undefined, pluginLine: undefined })[1]).toBe(
      "Plugin: none (no CLAUDE_PLUGIN_ROOT): this server was started from an MCP config, not the fmrl plugin.",
    );
    expect(lines({ ...base, pluginLine: undefined })[1]).toBe(`Plugin: manifest unreadable under ${base.pluginRoot}.`);
  });
  it("says there is no key yet, and that nothing was minted now", () => {
    expect(lines({ ...base, key: undefined, pages: 0 })[2]).toBe(
      "API https://fmrl.site: no key yet, the first publish mints one (nothing was minted now); no pages remembered.",
    );
  });
  it("names the environment variables a key and ring come from", () => {
    expect(lines({ ...base, key: { prefix: "fmrl_EEEE", source: "env", file: FILE, ring: "env" }, pages: 1 })[2]).toBe(
      "API https://fmrl.site: key fmrl_EEEE… from FMRL_API_KEY; key ring from FMRL_RING; 1 page remembered.",
    );
  });
  it("a redeemed key has no mint date, and a key without a ring says one comes with the first private page", () => {
    expect(lines({ ...base, key: { prefix: "fmrl_RDMD", source: "file", file: FILE, ring: "none" } })[2]).toBe(
      `API https://fmrl.site: key fmrl_RDMD… from ${FILE}; no key ring yet (the first private page mints one); 3 pages remembered.`,
    );
  });
  it("reports a failed last call by its code, and no call at all", () => {
    expect(lines({ ...base, lastCall: { method: "POST", path: "/publish", status: 0, code: "network", ms: 3002, at: NOW - 2_000 } })[3]).toBe(
      "Last call: POST /publish → failed (network) after 3002 ms, just now.",
    );
    expect(lines({ ...base, lastCall: { method: "GET", path: "/docs/…", status: 404, code: "not_found", ms: 80, at: NOW - 3 * 3_600_000 } })[3]).toBe(
      "Last call: GET /docs/… → 404 (not_found) in 80 ms, 3 h ago.",
    );
    expect(lines({ ...base, lastCall: undefined })[3]).toBe("No API call yet this session.");
  });
  describe("verbose", () => {
    const me = { prefix: "fmrl_K7QX", created_at: "x", label: "claude-code", quota: { publishes: { used: 3, limit: 25, resets_at: "2026-11-01T00:00:00Z" } }, linked_at: "2026-09-22T01:00:00Z" };
    it("reports reachability, quota, link state and the inbox, then npm", () => {
      const s: StatusSnapshot = { ...base, network: { api: { kind: "ok", ms: 180, me, inbox: 2 }, npm: { kind: "latest", version: "0.14.0" } } };
      expect(lines(s).slice(4)).toEqual([
        "fmrl.site: reachable, 180 ms. Quota: 3 of 25 publishes used this month, resets 2026-11-01T00:00:00Z. A browser linked on 2026-09-22T01:00:00Z. Inbox: 2 pages with unread revisions.",
        "npm: fmrl-mcp 0.14.0 is the latest.",
      ]);
    });
    it("a newer fmrl-mcp on npm means restart", () => {
      const s: StatusSnapshot = { ...base, network: { api: { kind: "ok", ms: 180, me: { ...me, linked_at: null }, inbox: 0 }, npm: { kind: "latest", version: "0.15.0" } } };
      expect(lines(s).slice(4)).toEqual([
        "fmrl.site: reachable, 180 ms. Quota: 3 of 25 publishes used this month, resets 2026-11-01T00:00:00Z. No browser link recorded. Inbox: empty.",
        "npm: fmrl-mcp 0.15.0 is the latest; this session runs 0.14.0, so restart Claude Code to pick it up.",
      ]);
    });
    it("probes without a key, and reports a refused key without replacing it", () => {
      expect(lines({ ...base, key: undefined, network: { api: { kind: "no_key", ms: 90 }, npm: { kind: "skipped", why: "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC is set" } } }).slice(4)).toEqual([
        "fmrl.site: reachable, 90 ms (answered 401 without a key, as expected).",
        "npm: not checked (CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC is set).",
      ]);
      expect(lines({ ...base, network: { api: { kind: "rejected", ms: 70, code: "key_revoked" }, npm: { kind: "failed", why: "No answer within 3 s." } } }).slice(4)).toEqual([
        "fmrl.site: reachable, 70 ms, but it refused key fmrl_K7QX… (key_revoked); nothing was replaced. fmrl_whoami says how to get a new one.",
        "npm: not reached (No answer within 3 s.).",
      ]);
    });
    it("says when fmrl.site is down", () => {
      expect(lines({ ...base, network: { api: { kind: "down", why: "Couldn't reach https://fmrl.site/api/v1: ECONNREFUSED" }, npm: { kind: "latest", version: "0.14.0" } } })[4]).toBe(
        "fmrl.site: unreachable (Couldn't reach https://fmrl.site/api/v1: ECONNREFUSED).",
      );
    });
    it("names a preview host by its base URL", () => {
      expect(lines({ ...base, baseUrl: "https://markymd-pr-9.a.run.app", network: { api: { kind: "no_key", ms: 1 }, npm: { kind: "latest", version: "0.14.0" } } })[4]).toMatch(/^https:\/\/markymd-pr-9\.a\.run\.app: reachable/);
    });
  });
});

describe("upFor and ago", () => {
  it("round to the unit that fits", () => {
    expect(upFor(45_000)).toBe("45 s");
    expect(upFor(3 * 60_000)).toBe("3 min");
    expect(upFor(2 * 3_600_000)).toBe("2 h");
    expect(upFor((26 * 60 + 5) * 60_000)).toBe("1 d 2 h");
    expect(ago(1_000)).toBe("just now");
    expect(ago(30_000)).toBe("30 s ago");
    expect(ago(90 * 60_000)).toBe("1 h ago");
    expect(ago(49 * 3_600_000)).toBe("2 d ago");
  });
});

describe("newestCachedPlugin", () => {
  /** cache lays out <dir>/<version>/.claude-plugin/plugin.json for each version, the way Claude Code's plugin cache does; bare names get no manifest. */
  const cache = async (versions: string[], bare: string[] = []): Promise<string> => {
    const dir = await mkdtemp(path.join(tmpdir(), "fmrl-cache-"));
    for (const v of versions) {
      await mkdir(path.join(dir, v, ".claude-plugin"), { recursive: true });
      await writeFile(path.join(dir, v, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "fmrl", version: v }));
    }
    for (const b of bare) await mkdir(path.join(dir, b), { recursive: true });
    return dir;
  };
  it("finds a newer version installed beside the one this session started on", async () => {
    const dir = await cache(["0.12.1", "0.14.0", "0.9.0"]);
    expect(await newestCachedPlugin(path.join(dir, "0.12.1"), "0.12.1")).toBe("0.14.0");
  });
  it("answers nothing when this session's version is the newest, or when a newer name has no manifest", async () => {
    const dir = await cache(["0.12.1", "0.14.0"], ["0.15.0", "latest"]);
    expect(await newestCachedPlugin(path.join(dir, "0.14.0"), "0.14.0")).toBeUndefined();
  });
  it("compares as versions, not strings, and says nothing for a parent it cannot read", async () => {
    const dir = await cache(["0.9.0", "0.10.0"]);
    expect(await newestCachedPlugin(path.join(dir, "0.9.0"), "0.9.0")).toBe("0.10.0");
    expect(await newestCachedPlugin("/nonexistent/fmrl/0.1.0", "0.1.0")).toBeUndefined();
  });
});

describe("statusText verbose, when the API answers an error other than 401", () => {
  it("says it is reachable and what it answered", () => {
    const s: StatusSnapshot = { ...base, network: { api: { kind: "error", ms: 60, status: 429, code: "rate_limited" }, npm: { kind: "latest", version: "0.14.0" } } };
    expect(lines(s)[4]).toBe("fmrl.site: reachable, 60 ms, but GET /me answered 429 (rate_limited).");
  });
});
