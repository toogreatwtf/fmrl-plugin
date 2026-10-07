import { describe, expect, it } from "vitest";
import { latestOnNpm } from "../src/registry.js";
import { hangingFetch } from "./fake-api.js";

const answer = (status: number, body: string) => (async () => new Response(body, { status })) as typeof fetch;

describe("latestOnNpm", () => {
  it("asks the registry for fmrl-mcp's latest version", async () => {
    const calls: string[] = [];
    const fetchImpl = (async (url: string | URL | Request) => { calls.push(String(url)); return new Response(JSON.stringify({ name: "fmrl-mcp", version: "0.15.0" }), { status: 200 }); }) as typeof fetch;
    expect(await latestOnNpm({ fetchImpl })).toBe("0.15.0");
    expect(calls).toEqual(["https://registry.npmjs.org/fmrl-mcp/latest"]);
  });
  it("throws a plain sentence on a bad answer, a non-version, or no answer in time", async () => {
    await expect(latestOnNpm({ fetchImpl: answer(503, "") })).rejects.toThrow("The npm registry answered 503.");
    await expect(latestOnNpm({ fetchImpl: answer(200, "{}") })).rejects.toThrow("The npm registry answered without a version.");
    await expect(latestOnNpm({ fetchImpl: answer(200, '{"version":"latest"}') })).rejects.toThrow("The npm registry answered without a version.");
    await expect(latestOnNpm({ fetchImpl: hangingFetch, timeoutMs: 20 })).rejects.toThrow(/^No answer from the npm registry within /);
    const refused = (async () => { throw new TypeError("fetch failed", { cause: new Error("ECONNREFUSED") }); }) as typeof fetch;
    await expect(latestOnNpm({ fetchImpl: refused })).rejects.toThrow("Couldn't reach the npm registry: ECONNREFUSED");
  });
});
