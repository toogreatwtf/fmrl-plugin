import { describe, expect, it } from "vitest";
import { parseDocId, parsePageRef } from "../src/ids.js";

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

describe("parsePageRef", () => {
  const id = "8apmpes8t6pk";
  const key = "K".repeat(43);
  const manage = "M".repeat(22);

  it("accepts a bare id, with and without whitespace", () => {
    expect(parsePageRef(id)).toEqual({ id });
    expect(parsePageRef(`  ${id}  `)).toEqual({ id });
  });

  it("accepts a bare id carrying a fragment", () => {
    expect(parsePageRef(`${id}#p=${key}`)).toEqual({ id, key });
  });

  it("extracts the id from a viewer link", () => {
    expect(parsePageRef(`https://fmrl.site/${id}`)).toEqual({ id });
  });

  it("extracts the id from a revision link", () => {
    expect(parsePageRef(`https://fmrl.site/${id}/rev/3`)).toEqual({ id });
  });

  it("extracts the id and manage token from a manage link", () => {
    expect(parsePageRef(`https://fmrl.site/manage/${id}#k=${manage}`)).toEqual({ id, manage });
  });

  it("extracts the id from an edit link", () => {
    expect(parsePageRef(`https://fmrl.site/edit/${id}`)).toEqual({ id });
  });

  it("accepts both p and k together, &-separated, in either order", () => {
    expect(parsePageRef(`https://fmrl.site/${id}#p=${key}&k=${manage}`)).toEqual({ id, key, manage });
    expect(parsePageRef(`https://fmrl.site/${id}#k=${manage}&p=${key}`)).toEqual({ id, key, manage });
  });

  it("drops a malformed p or k instead of throwing", () => {
    expect(parsePageRef(`${id}#p=tooshort`)).toEqual({ id });
    expect(parsePageRef(`${id}#k=tooshort`)).toEqual({ id });
    expect(parsePageRef(`${id}#p=${key}&k=tooshort`)).toEqual({ id, key });
    expect(parsePageRef(`${id}#p=not-base64url!!${"x".repeat(25)}&k=${manage}`)).toEqual({ id, manage });
  });

  it("ignores an unrelated fragment field and a valueless field", () => {
    expect(parsePageRef(`${id}#other=1&p=${key}`)).toEqual({ id, key });
    expect(parsePageRef(`${id}#p`)).toEqual({ id });
  });

  it("rejects anything that isn't a page id or a fmrl.site URL", () => {
    for (const bad of ["", "abc", "8APMPES8T6PK", "https://fmrl.site/", "https://fmrl.site/about", "not a url or id"]) {
      expect(() => parsePageRef(bad)).toThrow(/page id or a fmrl\.site URL/);
    }
  });
});
