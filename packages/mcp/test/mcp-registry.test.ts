import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// The official MCP Registry (registry.modelcontextprotocol.io) lists
// fmrl-mcp from server.json and checks the npm package it names: the
// published package.json must carry an `mcpName` equal to server.json's
// `name`, and the versions must be one that npm has. A release that bumps
// package.json without server.json, or the reverse, would make the next
// `mcp-publisher publish` fail or list a version that is not the latest.
const here = path.dirname(fileURLToPath(import.meta.url));
const json = (name: string) => JSON.parse(readFileSync(path.join(here, "..", name), "utf8"));
const pkg = json("package.json");
const server = json("server.json");

describe("the MCP Registry entry", () => {
  it("names the package by the mcpName the registry checks", () => {
    expect(pkg.mcpName).toBe("io.github.toogreatwtf/fmrl-mcp");
    expect(server.name).toBe(pkg.mcpName);
  });
  it("lists the version package.json is about to publish", () => {
    expect(server.version).toBe(pkg.version);
    expect(server.packages).toHaveLength(1);
    expect(server.packages[0]).toMatchObject({ registryType: "npm", identifier: pkg.name, version: pkg.version, transport: { type: "stdio" } });
  });
  it("keeps the description inside the registry's 100 characters", () => {
    expect(server.description.length).toBeGreaterThan(0);
    expect(server.description.length).toBeLessThanOrEqual(100);
  });
  it("points at this repository and folder", () => {
    expect(server.repository).toEqual({ url: "https://github.com/toogreatwtf/fmrl-plugin", source: "github", subfolder: pkg.repository.directory });
  });
});
