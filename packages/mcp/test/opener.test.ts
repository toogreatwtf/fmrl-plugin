import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { newRing, seal, sealRecord } from "../src/crypto.js";
import { openPrivatePage } from "../src/opener.js";
import { PageStore } from "../src/pages.js";

const id = "8apmpes8t6pk";
const newStore = async () => new PageStore("https://fmrl.test", path.join(await mkdtemp(path.join(tmpdir(), "fmrl-")), "pages.json"));

describe("openPrivatePage", () => {
  it("reports which key opened the page: the link's, the stored one, or the ring's", async () => {
    const { envelope, key } = await seal("<p>x</p>");
    const ring = newRing();
    const sealed = await sealRecord(ring, key, "X");
    const noRings = async () => [] as string[];

    const pages = await newStore();
    expect(await openPrivatePage({ id, key }, envelope, undefined, { pages, rings: noRings })).toEqual({ key, from: "link", html: "<p>x</p>" });
    expect(await openPrivatePage({ id }, envelope, undefined, { pages, rings: noRings })).toEqual({ key, from: "stored", html: "<p>x</p>" });

    const fresh = await newStore();
    expect(await openPrivatePage({ id }, envelope, sealed, { pages: fresh, rings: async () => [newRing(), ring] }))
      .toEqual({ key, from: "ring", html: "<p>x</p>", title: "X" });
    expect(await fresh.get(id)).toEqual({});
    expect(await openPrivatePage({ id }, envelope, sealed, { pages: fresh, rings: async () => [newRing()] })).toBeUndefined();
  });
  it("asks for the rings only when neither the link nor the store opens the page", async () => {
    const { envelope, key } = await seal("<p>x</p>");
    let asked = 0;
    const rings = async () => { asked++; return [] as string[]; };
    await openPrivatePage({ id, key }, envelope, "sealed", { pages: await newStore(), rings });
    expect(asked).toBe(0);
  });
  it("a sealed record whose key doesn't open the envelope is not taken on its word", async () => {
    const { envelope } = await seal("<p>x</p>");
    const ring = newRing();
    const sealed = await sealRecord(ring, "A".repeat(43), "Liar");
    expect(await openPrivatePage({ id }, envelope, sealed, { pages: await newStore(), rings: async () => [ring] })).toBeUndefined();
  });
  it("never replaces a stored manage token with one from a link", async () => {
    const { envelope, key } = await seal("<p>x</p>");
    const pages = await newStore();
    await pages.remember(id, { manage: "o".repeat(22) });
    await openPrivatePage({ id, key, manage: "n".repeat(22) }, envelope, undefined, { pages, rings: async () => [] });
    expect(await pages.get(id)).toEqual({ key, manage: "o".repeat(22) });
  });
  it("a link that can't be remembered still opens the page, and says so in the log", async () => {
    const { envelope, key } = await seal("<p>x</p>");
    const dir = await mkdtemp(path.join(tmpdir(), "fmrl-"));
    const pages = new PageStore("https://fmrl.test", path.join(dir, "missing", "\0bad", "pages.json"));
    const logs: string[] = [];
    const got = await openPrivatePage({ id, key }, envelope, undefined, { pages, rings: async () => [], log: (l) => logs.push(l) });
    expect(got?.from).toBe("link");
    expect(logs.join("\n")).toMatch(/couldn't remember page 8apmpes8t6pk/);
    expect(logs.join("\n")).not.toContain(key);
  });
});
