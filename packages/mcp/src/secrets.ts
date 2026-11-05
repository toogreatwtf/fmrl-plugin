/**
 * secretKinds names the kinds of credential that content plainly carries:
 * key material and tokens with a recognisable shape, not words like
 * "password" or a path like ~/.ssh, which docs mention all the time. A
 * public page with any of these is refused (publicRefusal); a private page
 * is the user's own business and is never scanned.
 *
 * The patterns are kept narrow on purpose: a false refusal costs a user a
 * public page they meant to share, so each one matches a token's real
 * prefix and length, not anything that merely looks random.
 */
const PATTERNS: Array<{ kind: string; re: RegExp }> = [
  { kind: "a private key block", re: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/ },
  { kind: "an AWS access key", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { kind: "a GitHub token", re: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{60,})\b/ },
  { kind: "a Slack token", re: /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/ },
  { kind: "an Anthropic API key", re: /\bsk-ant-[A-Za-z0-9_-]{20,}/ },
  { kind: "an OpenAI API key", re: /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{32,}/ },
  { kind: "a Google API key", re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { kind: "a Stripe secret key", re: /\b(?:sk|rk)_live_[0-9A-Za-z]{20,}\b/ },
  { kind: "an fmrl key", re: /\bfmrl_[A-Za-z0-9]{24,}\b/ },
];

export function secretKinds(content: string): string[] {
  const kinds: string[] = [];
  for (const { kind, re } of PATTERNS) {
    // An OpenAI-shaped match that is really an Anthropic key is named once, as the Anthropic one.
    if (kind === "an OpenAI API key" && kinds.includes("an Anthropic API key")) continue;
    if (re.test(content)) kinds.push(kind);
  }
  return kinds;
}

/** publicRefusal is the message for public content that carries secrets, or undefined when it carries none. Nothing is sent either way: the scan runs here. */
export function publicRefusal(content: string, verb: "publish" | "save"): string | undefined {
  const kinds = secretKinds(content);
  if (kinds.length === 0) return undefined;
  const list = kinds.length === 1 ? kinds[0] : `${kinds.slice(0, -1).join(", ")} and ${kinds.at(-1)}`;
  return `Nothing was sent: this content looks like it contains ${list}, and a public page can be read by anyone with the link. Take the secret out, or ${verb === "publish" ? "publish it private (leave out visibility)" : "keep it off this public page"}. Tell the person what you found; don't repeat the secret itself.`;
}
