import path from "node:path";
import { describe, expect, it } from "vitest";

import { fileName, fileStem, filesDir } from "../src/files.js";

const home = () => "/home/me";

describe("filesDir", () => {
  it("is ~/fmrl unless FMRL_FILES_DIR names another absolute folder", () => {
    expect(filesDir({}, home)).toBe(path.join("/home/me", "fmrl"));
    expect(filesDir({ FMRL_FILES_DIR: "  " }, home)).toBe(path.join("/home/me", "fmrl"));
    expect(filesDir({ FMRL_FILES_DIR: "/srv/pages/" }, home)).toBe(path.resolve("/srv/pages"));
    expect(filesDir({ FMRL_FILES_DIR: "~/work/fmrl" }, home)).toBe(path.join("/home/me", "work", "fmrl"));
    expect(filesDir({ FMRL_FILES_DIR: "~" }, home)).toBe(path.resolve("/home/me"));
    expect(() => filesDir({ FMRL_FILES_DIR: "pages" }, home)).toThrow("FMRL_FILES_DIR must be an absolute path");
  });
});

describe("fileName", () => {
  it("keeps only safe characters of the id", () => {
    expect(fileName("abc_12-x", "md")).toBe("abc_12-x.md");
    expect(fileName("../../etc/passwd", "html")).toBe("etcpasswd.html");
    expect(fileName("///", "md")).toBe("page.md");
    expect(fileStem("ab..c")).toBe("abc");
  });
});
