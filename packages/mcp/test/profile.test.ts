import { describe, expect, it } from "vitest";
import { readProfile, slug } from "../src/profile.js";
import { toHTML, wrapDocument } from "../src/markdown.js";

const block = (o: unknown) => "```fmrl-profile\n" + JSON.stringify(o) + "\n```\n";
const prof = {
  profile: "handoff-review", v: 1,
  sections: [
    { id: "header", purpose: "p", by: "author", required: true },
    { id: "review-map", purpose: "p", by: "author", required: true },
    { id: "review", purpose: "p", by: "any" },
    { id: "context-gaps", purpose: "p", by: "any", required: false },
  ],
  norms: ["evidence is a results table, not a transcript"],
};

describe("slug", () => {
  it("lowercases and joins runs outside [a-z0-9] with one dash", () => {
    expect(slug("Review map — where to look hardest")).toBe("review-map-where-to-look-hardest");
    expect(slug("  Decisions (recorded rulings) ")).toBe("decisions-recorded-rulings");
    expect(slug("Header")).toBe("header");
  });
});

describe("readProfile, Markdown", () => {
  const md = "# Title\n\n" + block(prof) + "\n## Header\n\nx\n\n## Review\n\ny\n\n## Review map — where to look hardest\n\nz\n\n```\n## not a heading\n```\n";
  it("parses the fence and maps sections by slug, exact matches first", () => {
    const r = readProfile(md, "md");
    expect(r.profile_error).toBeUndefined();
    expect(r.profile).toEqual({ ...prof, sections: prof.sections.map((s) => ({ required: false, ...s })) });
    expect(r.section_map).toEqual({
      header: { heading: "Header", position: 2 },
      review: { heading: "Review", position: 3 },
      "review-map": { heading: "Review map — where to look hardest", position: 4 },
    });
    expect(r.missing).toEqual(["context-gaps"]);
  });
  it("is empty when there is no block", () => {
    expect(readProfile("# Just a page\n", "md")).toEqual({});
  });
  it("reports a block that is not JSON, or not a profile, without throwing", () => {
    expect(readProfile("```fmrl-profile\n{nope\n```\n", "md").profile_error).toMatch(/not valid JSON/);
    expect(readProfile(block({ sections: "x" }), "md").profile_error).toMatch(/not a profile/);
    expect(readProfile(block({ profile: "p", v: 1, sections: [{ purpose: "no id" }] }), "md").profile_error).toMatch(/not a profile/);
  });
  it("defaults norms to [] and required to false", () => {
    const r = readProfile(block({ profile: "p", v: 1, sections: [{ id: "a" }] }), "md");
    expect(r.profile).toEqual({ profile: "p", v: 1, sections: [{ id: "a", purpose: "", by: "", required: false }], norms: [] });
  });
});

describe("readProfile, HTML", () => {
  it("reads the rendered script (with \\u003c) and heading slugs", () => {
    const html = wrapDocument(toHTML("# T\n\n" + block({ ...prof, note: "</script>" }) + "\n## Header\n\n## Context gaps\n"), "T");
    const r = readProfile(html, "html");
    expect(r.profile?.profile).toBe("handoff-review");
    expect(r.section_map?.header).toEqual({ heading: "Header", position: 2 });
    expect(r.section_map?.["context-gaps"]).toEqual({ heading: "Context gaps", position: 3 });
    expect(r.missing).toEqual(["review-map", "review"]);
  });
  it("lets data-fmrl-section beat a slug, on a heading or on an element holding one", () => {
    const script = `<script type="application/fmrl-profile+json" id="fmrl-profile">${JSON.stringify(prof)}</script>`;
    const html = `<html><body>${script}<h2>Header</h2><h2 data-fmrl-section="review">Where to look</h2>` +
      `<section data-fmrl-section="review-map"><h3>Hot spots</h3><p>…</p></section><h2>Context gaps</h2></body></html>`;
    const r = readProfile(html, "html");
    expect(r.section_map).toEqual({
      header: { heading: "Header", position: 1 },
      review: { heading: "Where to look", position: 2 },
      "review-map": { heading: "Hot spots", position: 3 },
      "context-gaps": { heading: "Context gaps", position: 4 },
    });
    expect(r.missing).toEqual([]);
  });
  it("ignores a script of any other type", () => {
    expect(readProfile('<script type="application/json">{"profile":"x"}</script>', "html")).toEqual({});
  });
});

describe("readProfile stays linear on hostile HTML", () => {
  const script = (o: unknown) => `<script type="application/fmrl-profile+json" id="fmrl-profile">${JSON.stringify(o)}</script>`;
  const MiB2 = 2 * 1024 * 1024;
  const junk = (unit: string) => unit.repeat(Math.ceil(MiB2 / unit.length));
  const timed = (html: string) => {
    const t0 = performance.now();
    const r = readProfile(html, "html");
    return { r, ms: performance.now() - t0 };
  };
  const cases: Array<[string, string]> = [
    ["unclosed data-fmrl-section start tags", script(prof) + junk("<a data-fmrl-section=x ")],
    ["unclosed h2 start tags", script(prof) + junk("<h2 ")],
    ["h2 elements that never close", script(prof) + junk("<h2>")],
    ["a heading full of unclosed tags", script(prof) + "<h2>" + junk("<a ") + "</h2>"],
    ["unclosed script start tags after the profile", script(prof) + junk("<script ")],
    ["unclosed script start tags before the profile", junk("<script ") + script(prof)],
    ["unclosed script start tags and no profile", junk("<script ")],
    ["scripts that never close and no profile", junk("<script>")],
    ["unclosed comments", script(prof) + junk("<!-- <h2>")],
  ];
  for (const [name, html] of cases) {
    it(`returns within 500 ms on ~2 MiB of ${name}`, () => {
      const { ms } = timed(html);
      expect(ms).toBeLessThan(500);
    });
  }
  it("still reads the profile after the junk", () => {
    expect(timed(script(prof) + junk("<h2 ")).r.profile?.profile).toBe("handoff-review");
  });
});

describe("readProfile, HTML bodies that are not markup", () => {
  it("ignores headings and marks inside scripts, styles and comments", () => {
    const html = `${`<script type="application/fmrl-profile+json">${JSON.stringify(prof)}</script>`}` +
      `<script>document.write("<h2>Review</h2>")</script><style>/* <h2>Review</h2> */</style>` +
      `<!-- <h2>Review</h2> <div data-fmrl-section="header"> --><h2>Header</h2><h2>Review</h2>`;
    const r = readProfile(html, "html");
    expect(r.section_map).toEqual({ header: { heading: "Header", position: 1 }, review: { heading: "Review", position: 2 } });
  });
  it("lists a repeated section id once", () => {
    const r = readProfile(block({ profile: "p", v: 1, sections: [{ id: "a", purpose: "first" }, { id: "a", purpose: "second" }] }), "md");
    expect(r.profile?.sections).toEqual([{ id: "a", purpose: "first", by: "", required: false }]);
    expect(r.missing).toEqual(["a"]);
  });
});

describe("readProfile, ids that are Object.prototype names", () => {
  it("maps and misses them like any other id", () => {
    const p = { profile: "p", v: 1, sections: [{ id: "tostring" }, { id: "toString" }, { id: "__proto__" }, { id: "constructor" }] };
    const r = readProfile(block(p) + "\n## toString\n", "md");
    // slug("toString") is "tostring": the lowercase id claims it, and the three names are missing.
    expect(JSON.parse(JSON.stringify(r.section_map))).toEqual({ tostring: { heading: "toString", position: 1 } });
    expect(r.missing).toEqual(["toString", "__proto__", "constructor"]);
    const html = `<script type="application/fmrl-profile+json">${JSON.stringify(p)}</script>` +
      `<h2 data-fmrl-section="__proto__">Proto</h2><h2 data-fmrl-section="constructor">Ctor</h2><h2 data-fmrl-section="toString">TS</h2>`;
    const h = readProfile(html, "html");
    expect(Object.getPrototypeOf(h.section_map)).toBe(Object.prototype);
    expect(Object.hasOwn(h.section_map!, "__proto__")).toBe(true);
    // A "__proto__" key in an object literal sets the prototype, so the expected value is parsed, as the actual one is.
    expect(JSON.parse(JSON.stringify(h.section_map))).toEqual(JSON.parse(
      '{"__proto__":{"heading":"Proto","position":1},"constructor":{"heading":"Ctor","position":2},"toString":{"heading":"TS","position":3}}'));
    expect(h.missing).toEqual(["tostring"]);
  });
});
