import { describe, expect, it } from "vitest";
import { firstHeading, looksLikeHTML, toHTML, wrapDocument } from "../src/markdown.js";

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
});
