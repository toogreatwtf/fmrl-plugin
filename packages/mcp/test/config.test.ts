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
  it("passes FMRL_RING through and treats an empty one as absent", () => {
    const ring = "r".repeat(43);
    expect(loadConfig({ FMRL_RING: ` ${ring} ` }).ring).toBe(ring);
    expect(loadConfig({ FMRL_RING: " " }).ring).toBeUndefined();
  });
  it("refuses a malformed FMRL_RING without echoing it", () => {
    const secret = "s3cret-but-not-a-ring";
    expect(() => loadConfig({ FMRL_RING: secret })).toThrow("FMRL_RING must be a key ring, 43 base64url characters; got 21 characters.");
    let message = "";
    try { loadConfig({ FMRL_RING: secret }); } catch (e) { message = (e as Error).message; }
    expect(message).not.toContain(secret);
  });
});
