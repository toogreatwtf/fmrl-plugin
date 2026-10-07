---
name: status
description: Show the fmrl plugin's status in one short block, answered from local state at once — fmrl-mcp and plugin versions, what launched the server and how long ago, the key and key ring on this machine, the last API call. Add "verbose" for the network checks — whether fmrl.site answers, quota, inbox, and the newest fmrl-mcp on npm. Use when the user asks whether fmrl is connected, up to date, or working.
argument-hint: [verbose]
---

# /fmrl:status — is fmrl connected, current, and working?

Argument: "$ARGUMENTS"

1. Call `fmrl_status` once. Pass `verbose: true` only when the argument is `verbose`, `-v`, `--verbose` or `full`; otherwise pass nothing. The default answer is local and immediate; verbose asks fmrl.site and npm, each call bounded, and takes a few seconds at most.
2. Relay the result unchanged, as one fenced block, and stop. Add nothing to it, call no other tool, and run no shell command: everything asked for is in the block, and anything more costs the time this command exists to save.
3. If `fmrl_status` is not available, the fmrl plugin's MCP server is not connected in this session. Say so, and point to `/mcp` to see why and to `/reload-plugins` or a restart to reconnect. Do not try `fmrl_whoami` or any other tool instead.
4. If a second fmrl server is connected too — tools named `fmrl_*` offered by another server, such as the hosted connector — say so in one line after the block, naming it as your harness names it. Do not call it.
5. If the block says the plugin is out of date, or that a newer plugin or fmrl-mcp is already there, do not act on it: `/fmrl:whoami` is the command that offers the update, with the user's OK.

## Never

- Never mint a key, publish, or write anything to answer status; `fmrl_status` does none of these, and neither should you.
- Never update the plugin, enable auto-update, or change settings from this command.
- Never print a key, the ring, or credentials-file contents; the block names the key by its prefix alone, and that is all to show.
- Never edit installed plugin caches (including ~/.claude/plugins or ~/.codex/plugins/cache).
