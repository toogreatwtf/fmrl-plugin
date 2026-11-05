# fmrl

Share anything your AI made. This plugin publishes a page to [fmrl.site](https://fmrl.site) and hands back a link. No account is needed; a page lasts seven days unless someone keeps it.

It adds three skills, `/fmrl:share`, `/fmrl:whoami` and `/fmrl:status`, and twelve tools: `fmrl_publish`, `fmrl_publish_file`, `fmrl_get`, `fmrl_edit`, `fmrl_watch`, `fmrl_inbox`, `fmrl_list`, `fmrl_delete`, `fmrl_whoami`, `fmrl_status`, `fmrl_redeem` and `fmrl_rotate`.

## Install

In Claude Code:

```
/plugin install fmrl --marketplace toogreatwtf/fmrl-plugin
```

## What it runs

One local MCP server, `fmrl-mcp`, at the exact version named in `.mcp.json`. `npx` downloads that version from npm the first time and starts it with Node 20 or newer. The server's source is in this repository, under `packages/mcp`. Nothing else runs, and the plugin has no hooks.

## What it sends

- To fmrl.site: what you or your agent choose to publish, edit, read, watch, list or delete, and the API key that makes those calls. A private page is encrypted on your machine first, and fmrl.site never gets the key that opens it.
- On first use, a request to fmrl.site for a new API key.
- If your key is attached to an fmrl account with private-page sync on, your key rings, sealed on your machine to your account's vault so that only your signed-in browser can open them.
- Only when you run `/fmrl:status verbose`: one request to the npm registry for the newest `fmrl-mcp` version.

## What it stores

- `~/.config/fmrl/credentials.json` (`%APPDATA%\fmrl\credentials.json` on Windows): your API key, your key rings and your vault fingerprint, readable only by you. Back it up to keep every private page's key.
- `pages.json` in the same folder: for each page this machine has opened or edited, its content key (private pages only) and any manage token that worked.
- Only if you say yes when the plugin offers it: `autoUpdate: true` for this marketplace in your Claude Code settings, so the plugin keeps itself current.

Privacy policy: [fmrl.site/privacy](https://fmrl.site/privacy). Help: [fmrl.site/support](https://fmrl.site/support). Full documentation: the [repository README](https://github.com/toogreatwtf/fmrl-plugin#readme).
