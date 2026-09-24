---
name: whoami
description: Show this machine's fmrl.site key — its prefix, this month's publishes, whether a browser is linked, where the key ring is kept — and whether the fmrl plugin is up to date. Use when the user asks about their fmrl key, quota, linked browser, key ring backup, or fmrl plugin version.
---

# /fmrl:whoami — this key, its quota, and whether the plugin is current

Use this when the user asks which fmrl key this is, how many publishes are left, whether a browser is linked, where the key ring is kept, or whether the fmrl plugin is up to date. It is also how the user confirms a plugin update worked, after restarting Claude Code.

## Steps

1. Call `fmrl_whoami` once.
2. Reply in a few lines: the key's prefix and how many of this month's publishes it has used, with the reset date; whether a browser is linked; and where the key ring is kept, with the advice to back it up.
3. If the result offers a link to see this key's pages on fmrl.site, relay it once, with its link unchanged: the part after `#r=` is what lets that browser open the private pages.
4. If the result carries a plugin line, relay it. If it says the plugin is out of date, offer to update it. Run `claude plugin marketplace update fmrl-plugin`, then `claude plugin update fmrl@fmrl-plugin`, only once the user says yes, and then tell them to restart Claude Code. If you can't run shell commands, give them the steps: `/plugin marketplace update fmrl-plugin`, then /plugin → Installed → fmrl → Update now, and restart. The line also says whether auto-update is on for its marketplace. Offer to turn it on **only when the line says it is off**, and only once in a conversation: with their yes, set `autoUpdate` to true on the `fmrl-plugin` entry under `extraKnownMarketplaces` in their user settings file (`$CLAUDE_CONFIG_DIR/settings.json`, else `~/.claude/settings.json`), leaving the rest of the file alone; the switch is also in /plugin → Marketplaces → fmrl-plugin → Enable auto-update, and it takes effect at the next start. When the line says auto-update is on, or says nothing about it, do not raise it at all — including when the plugin is out of date, since a plugin can be behind with the switch already on. If there is no plugin line, this server was not launched by the Claude Code plugin; say nothing about the plugin.
5. If the call fails, report the tool's message.

## Never

- Never print the ring on its own: it travels only inside the browser link, after `#r=`, and that part is never stripped when relaying the link.
- Never open the link yourself; it is for the person's browser.
- Never edit files under ~/.claude/plugins by hand.
- Never publish anything from this command.
