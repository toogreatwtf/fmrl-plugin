# Cursor plugin

Marty puts Cursor users on par with Claude Code and Codex users (2026-10-30). markymd PR 311 gave Cursor a one-click MCP install, which brings the twelve tools but not the skills. This makes `plugins/fmrl` a Cursor plugin too, so Cursor gets the share, whoami and status skills the way Claude Code and Codex do. Checked against cursor.com/docs/reference/plugins, cursor.com/docs/plugins.md, cursor.com/docs/skills.md and the public cursor/plugin-template (its marketplace, starter manifests and validate-template.mjs), 2026-10-30.

### Task 1

`.cursor-plugin/marketplace.json` at the repo root names the one plugin, `fmrl`, at `./plugins/fmrl`, the folder Claude Code's marketplace already names. Cursor's Customize can then import the repository from GitHub. `plugins/fmrl/.cursor-plugin/plugin.json` is the Cursor manifest: the Claude manifest's name, version and fields, with `displayName` as the template has it and no slash commands in the description, since Cursor's docs name skills `/skill-name` and say nothing of a plugin prefix. Skills come from `skills/` by Cursor's folder discovery; nothing in them moves.

### Task 2

`plugins/fmrl/mcp.json`, the file Cursor discovers (Claude Code reads `.mcp.json`), starts the same `npx -y fmrl-mcp` and sets `CLAUDE_PLUGIN_ROOT` to `${CURSOR_PLUGIN_ROOT}`, which Cursor expands in env values. fmrl-mcp reads the plugin's version from that root's `.claude-plugin/plugin.json`, so `fmrl_status` and `fmrl_whoami` report the installed plugin in Cursor too instead of "started from an MCP config". The surface stays "unknown" (the client that installed it); naming Cursor there is a server change for a later fmrl-mcp release.

### Task 3

The whoami skill's client list gains a Cursor line (Customize, never Claude CLI commands), and the status skill says how to see and reconnect the server in Cursor. Both READMEs gain the Cursor install step.

### Task 4

`test/plugin-files.test.ts` holds the template validator's rules (kebab names, owner, safe relative source, manifest under the source, names match, skills with a name matching the folder and a description), the Cursor manifest's version equal to the Claude manifest's, the same server in both MCP files, and the copy above. A release now bumps both manifests.

Not verified in Cursor itself: no Cursor runs in this sandbox. Marty tries it locally before merging.
