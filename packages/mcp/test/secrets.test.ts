import { describe, expect, it } from "vitest";

import { publicRefusal, secretKinds } from "../src/secrets.js";

// A token-shaped body with digits and mixed case, as real keys have; not any real key.
const T = (n: number) => "aB3dE5gH7jK9mN2pQ4sT6vW8yZ1cF0xL".repeat(4).slice(0, n);

describe("secretKinds", () => {
  it.each([
    ["-----BEGIN RSA PRIVATE KEY-----", "a private key block"],
    ["-----BEGIN PRIVATE KEY-----", "a private key block"],
    ["AKIA" + "Q7RZ3MXK5T2WB9PD", "an AWS access key"],
    // All letters is still a real key id: AWS ids draw from A-Z and 2-7, and about one in thirty has no digit.
    ["AKIA" + "QRZMXKTWBPDLHJNC", "an AWS access key"],
    ["ghp_" + T(36), "a GitHub token"],
    ["github_pat_" + T(32) + "_" + T(37), "a GitHub token"],
    ["xoxb-1234567890-abcdef", "a Slack token"],
    ["sk-ant-api03-" + T(40), "an Anthropic API key"],
    ["sk-proj-" + T(40), "an OpenAI API key"],
    ["AIza" + T(35), "a Google API key"],
    ["sk_live_" + T(24), "a Stripe secret key"],
    ["glpat-" + T(20), "a GitLab token"],
    ["npm_" + T(36), "an npm token"],
    ["hf_" + T(34), "a Hugging Face token"],
    ["fmrl_" + T(32), "an fmrl key"],
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
    // Documentation stand-ins: AWS's own example key, x-filled and spelled-out placeholders.
    "aws_access_key_id = AKIAIOSFODNN7EXAMPLE",
    "OPENAI_API_KEY=sk-proj-" + "x".repeat(40),
    "STRIPE_KEY=sk_live_" + "x".repeat(24),
    "SLACK_BOT_TOKEN=xoxb-your-token-here-example",
    "GITHUB_TOKEN=ghp_" + "x".repeat(36),
    "GITHUB_TOKEN=ghp_" + "0".repeat(36),
    "GITHUB_TOKEN=ghp_yourPersonalAccessTokenGoesRightHere1",
    "OPENAI_API_KEY=sk-proj-REPLACE_WITH_YOUR_OWN_PROJECT_KEY_1234",
    "GITLAB_TOKEN=glpat-" + "x".repeat(20),
    "NPM_TOKEN=npm_" + "x".repeat(36),
    "HF_TOKEN=hf_" + "x".repeat(34),
    // Names that merely contain "sk-": CSS classes and kebab-case identifiers.
    ".sk-skeleton-loader-container-placeholder-wrapper2 { display: none }",
    "schedule: sk-learning-rate-schedule-warmup-cosine-decay-v2",
    "class=\"mask-sk-" + T(40) + "\"",
  ])("leaves ordinary writing about secrets alone: %s", (content) => {
    expect(secretKinds(content)).toEqual([]);
  });
  it("names several kinds once each, and the refusal never carries the value", () => {
    const aws = "AKIA" + "Q7RZ3MXK5T2WB9PD";
    const msg = publicRefusal(`${aws}\nsk-ant-api03-${T(40)}`, "publish")!;
    expect(msg).toContain("an AWS access key and an Anthropic API key");
    expect(msg).not.toContain(aws);
    expect(publicRefusal("# fine", "publish")).toBeUndefined();
  });
  it("scans the title too, and tells a caller how to go private in words that work for either form", () => {
    const msg = publicRefusal("# fine", "publish", `deploy ghp_${T(36)}`)!;
    expect(msg).toContain("a GitHub token");
    expect(msg).toContain('visibility: "private"');
    expect(msg).not.toContain(T(36));
  });
  it("still finds a real-shaped key on a line that also has a placeholder", () => {
    expect(secretKinds(`example: AKIAIOSFODNN7EXAMPLE\nreal: AKIAQ7RZ3MXK5T2WB9PD`)).toEqual(["an AWS access key"]);
  });
  it("finds a key that markup splits, as the page reads (markymd's SecretKindsHTML)", () => {
    expect(secretKinds(`<pre><span class="t">ghp</span><span>_${T(36)}</span></pre>`)).toEqual(["a GitHub token"]);
    expect(secretKinds(`<code>ghp&#95;${T(36)}</code>`)).toEqual(["a GitHub token"]);
    expect(secretKinds(`<p>AKIA<!-- -->Q7RZ3MXK5T2WB9PD</p>`)).toEqual(["an AWS access key"]);
  });
  it("lets a real key through only when a stand-in word is a word of its own and most of it is words", () => {
    // Random runs that happen to hold the letters of "here" or "dummy" are still keys.
    expect(secretKinds("AKIAQ7RZ3MXKHERE5T2W")).toEqual(["an AWS access key"]);
    expect(secretKinds("ghp_Q7RZ3dummyK9mN2pQ4sT6vW8yZ1cF0xLaB3dE5")).toEqual(["a GitHub token"]);
    expect(secretKinds("GITHUB_TOKEN=ghp_YOUR_PERSONAL_ACCESS_TOKEN_GOES_HERE")).toEqual([]);
  });
  it("names an Anthropic key once and still finds an OpenAI key beside it", () => {
    expect(secretKinds(`sk-ant-api03-${T(40)}`)).toEqual(["an Anthropic API key"]);
    expect(secretKinds(`sk-ant-api03-${T(40)}\nsk-proj-${T(40)}`)).toEqual(["an Anthropic API key", "an OpenAI API key"]);
  });
});
