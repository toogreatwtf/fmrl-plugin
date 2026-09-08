import { describe, expect, it } from "vitest";
import { parseDocId } from "../src/ids.js";

describe("parseDocId", () => {
  it("accepts a bare id", () => {
    expect(parseDocId("8apmpes8t6pk")).toBe("8apmpes8t6pk");
    expect(parseDocId("  8apmpes8t6pk ")).toBe("8apmpes8t6pk");
  });
  it("extracts the id from viewer, raw and manage URLs", () => {
    expect(parseDocId("https://fmrl.site/8apmpes8t6pk")).toBe("8apmpes8t6pk");
    expect(parseDocId("https://fmrl.site/8apmpes8t6pk/raw")).toBe("8apmpes8t6pk");
    expect(parseDocId("https://fmrl.site/manage/8apmpes8t6pk#k=abc")).toBe("8apmpes8t6pk");
    expect(parseDocId("https://markymd-pr-27-x.a.run.app/8apmpes8t6pk?x=1")).toBe("8apmpes8t6pk");
  });
  it("rejects anything else", () => {
    for (const bad of ["", "abc", "8APMPES8T6PK", "https://fmrl.site/", "https://fmrl.site/about", "not a url or id"]) {
      expect(() => parseDocId(bad)).toThrow(/id or a fmrl\.site URL/);
    }
  });
});
