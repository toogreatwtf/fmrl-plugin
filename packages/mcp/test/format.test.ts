import { describe, expect, it } from "vitest";
import { ACCEPTED_EXTENSIONS, MAX_BYTES, formatForPath } from "../src/format.js";

describe("formatForPath", () => {
  it("maps html extensions", () => {
    expect(formatForPath("/a/b.html")).toBe("html");
    expect(formatForPath("C:\\x\\Y.HTM")).toBe("html");
  });
  it("maps markdown-ish extensions", () => {
    for (const ext of [".md", ".markdown", ".mdx", ".txt"]) expect(formatForPath(`/p/f${ext}`)).toBe("md");
  });
  it("refuses everything else by name", () => {
    for (const bad of ["/p/f.pdf", "/p/f.docx", "/p/noext", "/p/.md"]) {
      expect(() => formatForPath(bad)).toThrow(/\.html, \.htm, \.md, \.markdown, \.mdx, \.txt/);
    }
  });
  it("exposes the list and the cap", () => {
    expect(ACCEPTED_EXTENSIONS).toEqual([".html", ".htm", ".md", ".markdown", ".mdx", ".txt"]);
    expect(MAX_BYTES).toBe(2097152);
  });
});
