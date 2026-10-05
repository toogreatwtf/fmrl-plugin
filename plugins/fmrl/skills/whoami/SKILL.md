---
name: whoami
description: Show this machine's fmrl key prefix, monthly publishes, browser-link history, key-ring backup location, and available plugin version information. Use for questions about the key, quota, browser linking, private-key backup, or plugin version.
---

# /fmrl:whoami — this key and the next step

1. Call `fmrl_whoami` once.
2. Reply in a few useful lines: key label/prefix, quota and reset date; the browser handoff; backup advice; and rotation or plugin information when supplied. `linked_at` records a past link: it does not establish the current browser's link or account status.
3. Relay the supplied browser link once, unchanged, including its complete `#r=` fragment. Explain: link your browser to see your canvases. If sign-in is available there, optionally connect this plugin to your account to find its canvases on other devices. Let the browser offer the appropriate action; do not invent account status or a separate sign-in URL. Sharing does not require an account.
4. Keep the backup advice: back up the named credentials file, or the `FMRL_RING` value when that is the source. Signing in does not back up private-page keys. If saving the ring failed, relay that recovery message rather than claiming a saved backup exists.
5. Relay a plugin line when supplied. A shared plugin manifest or `CLAUDE_PLUGIN_ROOT` alone does not identify the client. Use client-specific instructions only when the launcher is known:
   - Claude CLI: offer `claude plugin marketplace update fmrl-plugin`, then `claude plugin update fmrl@fmrl-plugin`, only once the user says yes; restart Claude Code afterward. Offer the marketplace auto-update switch only when the result says it is off and supported, and change settings only with explicit permission. When auto-update does not run, do not offer the switch.
   - Claude desktop: use its plugin settings for updates.
   - Codex: use Codex's plugin settings; never give Claude CLI commands or promise Claude auto-update behavior.
   - Unknown: check the client that installed the plugin; do not guess commands or settings. No plugin line means version information is unavailable, not proof of a particular client.
6. If no browser link is supplied, relay that fact and the tool's supported recovery guidance. Do not fabricate a link or repeat whoami to obtain one. If the call fails or the key is revoked, relay its recovery message. `fmrl_redeem` accepts a key code the user already has.

## Never

- Never print the ring on its own, a full API key, or credentials-file contents. The ring travels only within the unchanged browser link.
- Never open the link yourself; it is for the person's browser.
- Never edit installed plugin caches (including ~/.claude/plugins or ~/.codex/plugins/cache).
- Never publish, update a plugin, enable auto-update, or overwrite user settings merely to answer whoami.
