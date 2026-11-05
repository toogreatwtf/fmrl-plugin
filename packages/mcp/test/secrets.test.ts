import { describe, expect, it } from "vitest";

import { publicRefusal, secretKinds } from "../src/secrets.js";

describe("secretKinds", () => {
  it.each([
    ["-----BEGIN RSA PRIVATE KEY-----", "a private key block"],
    ["-----BEGIN PRIVATE KEY-----", "a private key block"],
    ["AKIA" + "Q".repeat(16), "an AWS access key"],
    ["ghp_" + "x".repeat(36), "a GitHub token"],
    ["github_pat_" + "x".repeat(70), "a GitHub token"],
    ["xoxb-1234567890-abcdef", "a Slack token"],
    ["sk-ant-api03-" + "x".repeat(40), "an Anthropic API key"],
    ["sk-proj-" + "x".repeat(40), "an OpenAI API key"],
    ["AIza" + "x".repeat(35), "a Google API key"],
    ["sk_live_" + "x".repeat(24), "a Stripe secret key"],
    ["fmrl_" + "x".repeat(32), "an fmrl key"],
  ])("finds %s", (content, kind) => {
    expect(secretKinds(`before ${content} after`)).toEqual([kind]);
  });
  it.each([
    "Put your key in ~/.ssh/id_ed25519 and credentials.json, never in .env checked in.",
    "password: hunter2 is the classic example",
    "-----BEGIN PUBLIC KEY-----",
    "AKIA plus sixteen characters is the shape of an AWS key id",
    "fmrl_ABCD… is a key prefix",
    "sk-short",
  ])("leaves ordinary writing about secrets alone: %s", (content) => {
    expect(secretKinds(content)).toEqual([]);
  });
  it("names several kinds once each, and the refusal never carries the value", () => {
    const aws = "AKIA" + "Q".repeat(16);
    const msg = publicRefusal(`${aws}\nsk-ant-api03-${"y".repeat(40)}`, "publish")!;
    expect(msg).toContain("an AWS access key and an Anthropic API key");
    expect(msg).not.toContain(aws);
    expect(publicRefusal("# fine", "publish")).toBeUndefined();
  });
});
