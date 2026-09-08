import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

describe("loadConfig", () => {
  it("defaults to https://fmrl.site with no key", () => {
    expect(loadConfig({})).toEqual({ baseUrl: "https://fmrl.site", apiKey: undefined });
  });
  it("trims trailing slashes and whitespace from FMRL_API_URL", () => {
    expect(loadConfig({ FMRL_API_URL: " https://preview.example/// " }).baseUrl).toBe("https://preview.example");
  });
  it("passes FMRL_API_KEY through", () => {
    expect(loadConfig({ FMRL_API_KEY: "fmrl_abc" }).apiKey).toBe("fmrl_abc");
  });
  it("treats an empty FMRL_API_KEY as absent", () => {
    expect(loadConfig({ FMRL_API_KEY: "  " }).apiKey).toBeUndefined();
  });
  it("rejects a FMRL_API_URL with no scheme or a non-http(s) scheme", () => {
    expect(() => loadConfig({ FMRL_API_URL: "fmrl.site" })).toThrow(/FMRL_API_URL must be an http\(s\) URL/);
    expect(() => loadConfig({ FMRL_API_URL: "ftp://x" })).toThrow(/FMRL_API_URL must be an http\(s\) URL/);
  });
});
