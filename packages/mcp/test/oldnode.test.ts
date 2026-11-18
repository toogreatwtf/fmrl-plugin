import { describe, expect, it } from "vitest";

import { MIN_NODE, nodeMajor, tooOldReply, tooOldText } from "../src/oldnode.js";

describe("an fmrl-mcp started on a Node that's too old", () => {
  it("reads the major version, and nothing odd as new enough", () => {
    expect(nodeMajor("18.20.8")).toBe(18);
    expect(nodeMajor("22.1.0")).toBe(22);
    expect(nodeMajor("")).toBe(0);
    expect(nodeMajor("x.y")).toBe(0);
    expect(nodeMajor("18.20.8") < MIN_NODE).toBe(true);
    expect(nodeMajor("20.0.0") < MIN_NODE).toBe(false);
  });

  it("connects with no tools and instructions that say why", () => {
    const r = tooOldReply({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } }, "18.20.8") as { result: { protocolVersion: string; instructions: string; capabilities: object } };
    expect(r.result.protocolVersion).toBe("2025-06-18");
    expect(r.result.capabilities).toEqual({ tools: {} });
    expect(r.result.instructions).toContain(tooOldText("18.20.8"));
    expect(r.result.instructions).toContain("Node 20 or newer");
    expect(tooOldReply({ jsonrpc: "2.0", id: 2, method: "tools/list" }, "18.20.8")).toEqual({ jsonrpc: "2.0", id: 2, result: { tools: [] } });
    expect(tooOldReply({ jsonrpc: "2.0", id: 3, method: "ping" }, "18.20.8")).toEqual({ jsonrpc: "2.0", id: 3, result: {} });
  });

  it("answers any other request with an error that says why, and notifications not at all", () => {
    expect(tooOldReply({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "fmrl_publish" } }, "16.0.0")).toEqual({ jsonrpc: "2.0", id: 4, error: { code: -32601, message: tooOldText("16.0.0") } });
    expect(tooOldReply({ jsonrpc: "2.0", method: "notifications/initialized" }, "18.20.8")).toBeUndefined();
    expect(tooOldReply({ jsonrpc: "2.0", id: 5, result: {} }, "18.20.8")).toBeUndefined();
  });
});
