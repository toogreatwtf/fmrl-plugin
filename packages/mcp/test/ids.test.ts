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

describe("parsePageRef and a reserved slug", () => {
  // A fmrl.site link also carries the house pages internal/reserved serves
  // at short ids: 4-11 characters of the doc alphabet, never 12 (a minted
  // id is always 12, so the namespaces never meet). h4ndrv is the
  // handoff-review starter profile.
  it("accepts a bare reserved slug", () => {
    expect(parsePageRef("h4ndrv")).toEqual({ id: "h4ndrv" });
    expect(parsePageRef("  q7m2xk  ")).toEqual({ id: "q7m2xk" });
  });

  it("extracts a reserved slug from a fmrl.site link", () => {
    expect(parsePageRef("https://fmrl.site/h4ndrv")).toEqual({ id: "h4ndrv" });
    expect(parsePageRef("https://fmrl.site/h4ndrv/raw")).toEqual({ id: "h4ndrv" });
  });

  it("keeps a page key carried by a reserved slug's link", () => {
    const key = "K".repeat(43);
    expect(parsePageRef(`https://fmrl.site/t4ng3r#p=${key}`)).toEqual({ id: "t4ng3r", key });
  });

  it("prefers a full page id over a shorter segment on the same path", () => {
    expect(parsePageRef("https://fmrl.site/manage/8apmpes8t6pk")).toEqual({ id: "8apmpes8t6pk" });
    expect(parsePageRef("https://fmrl.site/edit/8apmpes8t6pk")).toEqual({ id: "8apmpes8t6pk" });
  });

  it("takes a slug from the configured base's host too, as a preview serves the same house pages", () => {
    const base = "https://markymd-pr-27-x.a.run.app";
    expect(parsePageRef(`${base}/h4ndrv`, { base })).toEqual({ id: "h4ndrv" });
    expect(parsePageRef("https://fmrl.test/h4ndrv/raw", { base: "https://fmrl.test/" })).toEqual({ id: "h4ndrv" });
    expect(parsePageRef("https://fmrl.site/h4ndrv", { base })).toEqual({ id: "h4ndrv" });
  });

  it("takes a slug only from the root of the path, where the viewer serves it", () => {
    expect(() => parsePageRef("https://fmrl.site/manage/h4ndrv")).toThrow(/page id or a fmrl\.site URL/);
    expect(() => parsePageRef("https://fmrl.site/edit/h4ndrv")).toThrow(/page id or a fmrl\.site URL/);
  });

  it("still refuses what is neither a page id, a slug nor a fmrl.site link", () => {
    for (const bad of [
      "abc", // too short for a slug
      "H4NDRV", // not the doc alphabet
      "h4ndrvi", // i is not in the alphabet
      "about", // a word outside the alphabet
      "https://fmrl.site/about",
      "https://fmrl.site/",
      "https://example.com/h4ndrv", // a slug is word-shaped: another host's word is not a page
      "https://example.com/marty",
      "https://github.com/toogreatwtf/fmrl-plugin",
      "not a url or id",
    ]) {
      expect(() => parsePageRef(bad)).toThrow(/page id or a fmrl\.site URL/);
    }
  });

  it("a minted id is still read from any host, as before", () => {
    expect(parsePageRef("https://example.com/8apmpes8t6pk")).toEqual({ id: "8apmpes8t6pk" });
  });

  it("parseDocId accepts a reserved slug the same way", () => {
    expect(parseDocId("h4ndrv")).toBe("h4ndrv");
    expect(parseDocId("https://fmrl.site/h4ndrv")).toBe("h4ndrv");
    expect(parseDocId("https://fmrl.test/h4ndrv", { base: "https://fmrl.test" })).toBe("h4ndrv");
    expect(() => parseDocId("https://example.com/h4ndrv")).toThrow(/document id or a fmrl\.site URL/);
  });
});

describe("parsePageRef's refusal", () => {
  it("never repeats the fragment, which may carry a page key", () => {
    const key = "Q".repeat(43);
    expect(() => parsePageRef(`https://fmrl.site/about#p=${key}`)).toThrow(/^"https:\/\/fmrl\.site\/about" is not a page id/);
  });
});

describe("parseDocId's refusal", () => {
  it("never repeats the fragment either", () => {
    const key = "Q".repeat(43);
    expect(() => parseDocId(`https://fmrl.site/about#p=${key}`)).toThrow(/^"https:\/\/fmrl\.site\/about" is not a document id/);
  });
});
