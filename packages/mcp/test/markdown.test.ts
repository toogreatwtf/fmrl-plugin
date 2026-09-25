import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { documentTitle, firstHeading, looksLikeHTML, readSource, toHTML, wrapDocument } from "../src/markdown.js";

// fixtures/profile-fences.json is a byte-for-byte copy of markymd's
// internal/render/testdata/profile-fences.json: the same cases the server's
// Go renderer passes, so the plugin's Markdown renderer writes the identical
// inert script for a ```fmrl-profile fence. Read synchronously (not a JSON
// import attribute, which this repo's vitest/tsconfig setup rejects) so each
// case can still become its own named `it`.
const profileCases = JSON.parse(
  readFileSync(new URL("./fixtures/profile-fences.json", import.meta.url), "utf8"),
) as { name: string; md: string; script: string | null }[];

describe("markdown", () => {
  it("looksLikeHTML matches share.DetectFormat", () => {
    expect(looksLikeHTML("<!doctype html><p>x")).toBe(true);
    expect(looksLikeHTML("  ﻿<html>")).toBe(true);
    expect(looksLikeHTML("</p>")).toBe(true);
    expect(looksLikeHTML("<?xml")).toBe(true);
    expect(looksLikeHTML("# heading")).toBe(false);
    expect(looksLikeHTML("1 < 2")).toBe(false);
    expect(looksLikeHTML("<3 you")).toBe(false);
  });
  it("renders GFM", () => {
    const html = toHTML("# Hi\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n~~gone~~");
    expect(html).toContain("<h1>Hi</h1>");
    expect(html).toContain("<table>");
    expect(html).toContain("<del>gone</del>");
  });
  it("wraps with the shell and escapes the title", () => {
    const doc = wrapDocument("<h1>Hi</h1>", "A <b> & \"q\"");
    expect(doc.startsWith("<!DOCTYPE html>\n<html>\n<head>\n<meta charset=\"utf-8\">")).toBe(true);
    expect(doc).toContain("<title>A &lt;b&gt; &amp; &quot;q&quot;</title>");
    expect(doc).toContain("<style>:root{color-scheme:light dark}");
    expect(doc).toContain("<body>\n<h1>Hi</h1>\n</body>");
    expect(wrapDocument("x", "")).toContain("<title>Document</title>");
  });
  it("firstHeading strips tags", () => {
    expect(firstHeading("<p>a</p><h2>Two <em>words</em></h2>")).toBe("Two words");
    expect(firstHeading("<p>none</p>")).toBe("");
  });
  it("firstHeading decodes marked's escaped entities", () => {
    expect(firstHeading('<h1>Tom &amp; Jerry &#39;s &lt;b&gt;</h1>')).toBe("Tom & Jerry 's <b>");
  });
  it("firstHeading decodes entities in a single pass, not layered", () => {
    expect(firstHeading('<h1>&#38;lt; &amp;lt; &#x26;amp;</h1>')).toBe("&lt; &lt; &amp;");
  });
  it("firstHeading bounds out-of-range numeric references instead of throwing", () => {
    expect(() =>
      firstHeading('<h1>a &#99999999; b &#xFFFFFFFF; c &#55296; d &#x41;</h1>')
    ).not.toThrow();
    expect(firstHeading('<h1>a &#99999999; b &#xFFFFFFFF; c &#55296; d &#x41;</h1>')).toBe(
      "a � b � c � d A"
    );
  });
  it("title survives toHTML -> firstHeading -> wrapDocument with only one layer of escaping", () => {
    const body = toHTML('# Tom & Jerry "quoted" <3');
    const doc = wrapDocument(body, firstHeading(body));
    expect(doc).toContain('<title>Tom &amp; Jerry &quot;quoted&quot; &lt;3</title>');
    const titleCount = (doc.match(/<title>Tom &amp; Jerry &quot;quoted&quot; &lt;3<\/title>/g) || []).length;
    expect(titleCount).toBe(1);
    expect(doc).not.toContain("&amp;amp;");
    expect(doc).not.toContain("&amp;quot;");
  });
  it("documentTitle is the browser's pageTitle: the <title> text, else the first heading", () => {
    expect(documentTitle("<html><head><title> A &amp; <b>B</b>\n </title></head><body><h1>H</h1></body></html>")).toBe("A & B");
    expect(documentTitle("<html><head><title> </title></head><body><h2>Two <em>words</em></h2></body></html>")).toBe("Two words");
    expect(documentTitle("<p>none</p>")).toBe("");
  });
});

describe("toHTML and the fmrl-profile fence", () => {
  const open = '<script type="application/fmrl-profile+json" id="fmrl-profile">';
  for (const c of profileCases) {
    it(c.name, () => {
      const got = toHTML(c.md);
      if (c.script === null) {
        expect(got).not.toContain("fmrl-profile+json");
        return;
      }
      expect(got).toContain(open + c.script + "</script>\n");
      expect(got).not.toContain("<pre");
      expect(got.split("</script").length - 1).toBe(1);
    });
  }
});

describe("readSource", () => {
  it("undoes exactly static/fmrl.js's escaping: &lt; then &amp;, in that order", () => {
    expect(readSource('<body><p>x</p><script type="text/x-fmrl-source" data-format="md">a &lt;b> &amp;lt; &amp;amp;</script></body>'))
      .toEqual({ format: "md", source: "a <b> &lt; &amp;" });
  });
  it("reads a block without data-format as Markdown, and an html block as HTML, as the edit page does", () => {
    expect(readSource('<script type="text/x-fmrl-source">x</script>')).toEqual({ format: "md", source: "x" });
    expect(readSource('<script data-format="html" type="text/x-fmrl-source">&lt;p></script>')).toEqual({ format: "html", source: "<p>" });
  });
  it("is undefined for a document with no block, or a block of a format it can't name", () => {
    expect(readSource("<p>no block</p><script>var x = 1;</script>")).toBeUndefined();
    expect(readSource('<script type="text/x-fmrl-source" data-format="rst">x</script>')).toBeUndefined();
  });
});
