import { mkdtemp, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { FileInTheWay, fileName, fileStem, filesDir, writeIn } from "../src/files.js";

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

describe("writeIn", () => {
  it("writes a new file, leaves one with the same content, and replaces a different one only when told to", async () => {
    const folder = await mkdtemp(path.join(tmpdir(), "fmrl-files-"));
    const file = path.join(folder, "page.md");
    expect(await writeIn(folder, "page.md", "# One")).toBe(file);
    expect(await readFile(file, "utf8")).toBe("# One");
    if (process.platform !== "win32") expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect((await stat(file)).nlink).toBe(1);
    expect(await writeIn(folder, "page.md", "# One")).toBe(file);
    await writeFile(file, "edits not saved");
    await expect(writeIn(folder, "page.md", "# Two")).rejects.toBeInstanceOf(FileInTheWay);
    expect(await readFile(file, "utf8")).toBe("edits not saved");
    expect(await writeIn(folder, "page.md", "# Two", { replace: true })).toBe(file);
    expect(await readFile(file, "utf8")).toBe("# Two");
    // No temporary file is left behind either way.
    expect(await readdir(folder)).toEqual(["page.md"]);
  });
});
