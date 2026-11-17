import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { canvasAssets } from "../src/highlight.js";
import { toHTML, wrapDocument } from "../src/markdown.js";
import { commentsShow, MAX_QUOTE, noteData, openNote, PageText, QuoteError, sealNote } from "../src/notes.js";

// fixtures/text-index.json is a copy of markymd's
// internal/annotate/testdata/text-index.json: a page body and the text
// fmrl.site's viewer indexes from it in the browser. Comments on a private
// page are placed by this plugin and drawn by the viewer, so the two must
// count every character the same.
const textCases = JSON.parse(
  readFileSync(new URL("./fixtures/text-index.json", import.meta.url), "utf8"),
) as { name: string; md: string; body: string; text: string }[];

const page = (md: string) => PageText.fromHTML(wrapDocument(toHTML(md), "t"));

const refusal = (f: () => unknown): QuoteError => {
  try {
    f();
  } catch (e) {
    if (e instanceof QuoteError) return e;
    throw e;
  }
  throw new Error("no refusal");
};

describe("the page's text, as the viewer indexes it", () => {
  // A public page's viewer serves the page with its frame script and a line
  // break before </body>, as markymd's annotate.WrapDocument does.
  const publicPage = (html: string) => html.replace(/<\/body>(?![\s\S]*<\/body>)/, "<script>frame</script>\n</body>");
  for (const c of textCases) {
    it(c.name, () => {
      expect(PageText.fromHTML(publicPage(wrapDocument(c.body, "t"))).raw).toBe(c.text);
    });
  }

  it("is the same text once the viewer adds its policy and script to a private page", () => {
    // static/fmrl-annotate.js's inject: the policy after the doctype, the script just before </body>.
    const inject = (html: string) => html.replace(/^<!DOCTYPE html>/, '<!DOCTYPE html><meta http-equiv="Content-Security-Policy" content="x">')
      .replace(/<\/body>(?![\s\S]*<\/body>)/, "<script>frame</script></body>");
    for (const c of textCases) {
      const html = wrapDocument(toHTML(c.md), "t");
      expect(PageText.fromHTML(inject(html)).raw, c.name).toBe(PageText.fromHTML(html).raw);
    }
  });

  it("leaves out scripts, styles, templates and fmrl's own marks", () => {
    const t = PageText.fromHTML("<!DOCTYPE html><html><head><title>x</title></head><body><p>a<script>b</script>c</p><style>d</style>" +
      "<template>e</template><noscript>f</noscript><span data-fmrl-a>g</span>h</body></html>");
    expect(t.raw).toBe("ach");
  });
});

describe("find", () => {
  it("makes the anchor a person's selection would", () => {
    const t = page("# Plan\n\nFirst we *read* the **brief**, then we write.\n\n## Risks\n\nNothing yet.\n");
    const p = t.find({ quote: "read the brief" });
    expect(p.anchor.quote).toBe("read the brief");
    expect(t.raw.slice(p.anchor.start, p.anchor.start + p.anchor.quote.length)).toBe("read the brief");
    expect(p.anchor.prefix.endsWith("First we ")).toBe(true);
    expect([...p.anchor.prefix].length).toBeLessThanOrEqual(32);
    expect(p.anchor.suffix.startsWith(", then")).toBe(true);
    expect(p.heading).toBe("Plan");
    expect(t.locate(p.anchor)).toEqual({ found: true, heading: "Plan" });
  });

  it("forgives Markdown, line breaks and spacing", () => {
    const t = page("Use `fmrl_get` to read **the page**\nbefore editing it.\n");
    for (const q of ["Use `fmrl_get` to read **the page** before", "read the page\nbefore editing", "read  the   page before"]) {
      expect(t.find({ quote: q }).anchor.quote).toContain("the page");
    }
  });

  it("matches curly quotes loosely and counts astral characters as two units", () => {
    const t = page("Ship it 🚀 now, “quoted” here.\n");
    const p = t.find({ quote: 'now, "quoted"' });
    expect(p.anchor.quote).toBe("now, “quoted”");
    expect(p.anchor.start).toBe(t.raw.indexOf("now"));
  });

  it("refuses words in more than one place, listing each by its heading", () => {
    const t = page("# One\n\nThe cat sat on the mat.\n\n# Two\n\nThe cat sat on the hat.\n");
    const e = refusal(() => t.find({ quote: "The cat sat" }));
    expect(e.code).toBe("quote_ambiguous");
    expect(e.message).toContain("in 2 places");
    expect(e.message).toContain('1. Under "One"');
    expect(e.message).toMatch(/2\. Under "Two": ".*hat/);
    expect(t.find({ quote: "The cat sat", suffix: "on the hat" }).heading).toBe("Two");
    expect(t.find({ quote: "The cat sat", occurrence: 1 }).heading).toBe("One");
    expect(refusal(() => t.find({ quote: "The cat sat", occurrence: 3 })).message).toContain("not on the page that many times");
    expect(refusal(() => t.find({ quote: "The cat sat", prefix: "nowhere" })).message).toMatch(/^The prefix and suffix fit none/);
  });

  it("refuses words not on the page, with the passages most like them", () => {
    const t = page("# Budget\n\nWe spend forty dollars on hosting each month.\n\n# Team\n\nTwo people review every change.\n");
    const e = refusal(() => t.find({ quote: "we spend fifty dollars on hosting" }));
    expect(e.code).toBe("quote_not_found");
    expect(e.message).toMatch(/- Under "Budget": ".*forty dollars/);
    expect(refusal(() => t.find({ quote: "  " })).code).toBe("bad_request");
    expect(refusal(() => t.find({ quote: "a".repeat(MAX_QUOTE + 1) })).message).toContain("over 2000");
  });
});

describe("locate", () => {
  it("follows the words and says when they are gone", () => {
    const before = page("# A\n\nKeep this sentence.\n\nDrop this one.\n");
    const keep = before.find({ quote: "Keep this sentence" });
    const drop = before.find({ quote: "Drop this one" });
    const after = page("# New intro\n\nSomething first.\n\n# A\n\nKeep this sentence.\n");
    expect(after.locate(keep.anchor)).toEqual({ found: true, heading: "A" });
    expect(after.locate(drop.anchor).found).toBe(false);
  });

  it("picks the copy whose surroundings fit, past an astral character", () => {
    const t = page("# A\n\n😀 one two\n\n# B\n\n😀 one three\n");
    expect(t.locate({ quote: "one", prefix: "😀 ", suffix: " three", start: 0 })).toEqual({ found: true, heading: "B" });
  });

  it("stays quick on a page of one repeated character", () => {
    const t = page("# Big\n\n" + "a".repeat(1 << 20) + "\n");
    const at = Date.now();
    expect(t.locate({ quote: "a", prefix: "", suffix: "", start: -1 })).toEqual({ found: true, heading: "Big" });
    expect(Date.now() - at).toBeLessThan(2000);
  });
});

describe("commentsShow", () => {
  it("shows comments on a page this plugin rendered", () => {
    expect(commentsShow(wrapDocument(toHTML("# Hi\n\n```js\nx\n```\n"), "Hi"), [canvasAssets.copyJS])).toBe(true);
  });

  it("doesn't on a page that could run code of its own", () => {
    for (const html of [
      "<p>x</p><script>alert(1)</script>",
      "<p>x</p><script src=a.js></script>",
      "<p onclick=x>x</p>",
      "<a href=' javascript:x'>x</a>",
      "<iframe src=a></iframe>",
      "<template><script>x</script></template>",
      "<!-- a comment first --><p>x</p>",
    ]) expect(commentsShow(html, [canvasAssets.copyJS]), html).toBe(false);
    expect(commentsShow('<p>x</p><script type="application/json">{}</script>', [])).toBe(true);
  });
});

describe("sealed notes", () => {
  const key = Buffer.alloc(32, 7).toString("base64url");

  it("round-trip under the page's key and id only", async () => {
    const note = { anchor: { quote: "a", prefix: "", suffix: "", start: 0 }, body: "hi" };
    const sealed = await sealNote(key, "abc", note);
    expect(sealed).toMatch(/^s1\.[A-Za-z0-9_-]+$/);
    expect(await openNote(key, "abc", sealed)).toEqual(note);
    await expect(openNote(key, "abd", sealed)).rejects.toThrow();
    await expect(openNote(Buffer.alloc(32, 8).toString("base64url"), "abc", sealed)).rejects.toThrow();
    await expect(openNote(key, "abc", JSON.stringify(note))).rejects.toThrow();
  });

  it("open what the viewer seals", async () => {
    // Sealed the way static/fmrl-annotate.js does: AES-GCM, a 12-byte nonce
    // first, "fmrl-annotation:" and the page id as additional data.
    const iv = new Uint8Array(12).fill(1);
    const k = await crypto.subtle.importKey("raw", Buffer.alloc(32, 7), "AES-GCM", false, ["encrypt"]);
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: new TextEncoder().encode("fmrl-annotation:abc") }, k,
      new TextEncoder().encode('{"body":"from the browser"}')));
    const sealed = "s1." + Buffer.concat([iv, ct]).toString("base64url");
    expect(noteData(await openNote(key, "abc", sealed))).toEqual({ body: "from the browser" });
  });

  it("read as the viewer reads them", () => {
    expect(noteData(null)).toEqual({ body: "" });
    expect(noteData({ body: 3, anchor: { quote: "" } })).toEqual({ body: "" });
    expect(noteData({ body: "x", anchor: { quote: "q", start: 4.7 } })).toEqual({ body: "x", anchor: { quote: "q", prefix: "", suffix: "", start: 4 } });
  });
});
