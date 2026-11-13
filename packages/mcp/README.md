# fmrl

Your agent's outbox. Ask it to publish to fmrl and get a shareable link to your page, no account required. Agents and people can edit and organize pages together. Pages expire on their own unless you keep them, and private ones are encrypted before they leave your device.

This repository holds the fmrl plugin for Claude Code and Cursor, and `fmrl-mcp`, the MCP server behind it that works in any MCP client.

## Install

**Claude Code**

```
/plugin marketplace add toogreatwtf/fmrl-plugin
/plugin install fmrl@fmrl-plugin
```

Keep it current: auto-update is your switch, under /plugin → Marketplaces → fmrl-plugin → Enable auto-update, and the plugin offers once to turn it on. In the Claude desktop app the switch does nothing: update by hand, or when the plugin says it is out of date. By hand, run `claude plugin marketplace update fmrl-plugin`, then `claude plugin update fmrl@fmrl-plugin`, and restart Claude Code.

**Cursor**

Open Customize, then Plugins, choose Add and Import Marketplace, paste `https://github.com/toogreatwtf/fmrl-plugin` as the repository (the full address, not `owner/repo`), and add fmrl.

**Any MCP client** (Claude Desktop, Codex, Windsurf and the rest)

```json
{ "mcpServers": { "fmrl": { "command": "npx", "args": ["-y", "fmrl-mcp"] } } }
```

There's no sign-up or key to paste. The server makes a key the first time it publishes.

## Use it

Ask your agent to share something: "publish this report to fmrl". You get back a link, when the page expires, and a manage link for editing it later.

Pages are private by default: encrypted on your machine, readable by anyone you give the full link, but not by fmrl.site. A page lasts seven days unless someone keeps it from the page itself, and a kept private page stays encrypted.

In Claude Code and Cursor, the plugin adds four skills:

- `/fmrl:share`: publish a file or something the agent wrote, and reply with the link.
- `/fmrl:attach`: connect this agent to your fmrl account, so its pages show up under Pages on fmrl.site.
- `/fmrl:whoami`: your key, this month's publishes, and whether the plugin is up to date.
- `/fmrl:status`: a quick health check; `/fmrl:status verbose` also checks fmrl.site and npm.

## Tools

Any MCP client gets fourteen tools:

| Tool | Does |
|---|---|
| `fmrl_publish` | Publish content as a page and return its link. |
| `fmrl_publish_file` | Publish an HTML, Markdown or text file from disk. |
| `fmrl_get` | Read a page, or one revision of it. |
| `fmrl_edit` | Save a new revision of a page you own or were given a manage link for. |
| `fmrl_watch` | Follow a page so other people's edits show up in your inbox. |
| `fmrl_inbox` | List watched pages that someone else has changed. |
| `fmrl_list` | List the pages this key published. |
| `fmrl_set_visibility` | Make a page public or private, with a preview before anything goes public. |
| `fmrl_delete` | Delete a page this key published. |
| `fmrl_attach` | Get a one-time link that connects this agent to your fmrl account. |
| `fmrl_whoami` | Show the key, this month's quota and attachment state. |
| `fmrl_status` | Show versions, the key on this machine and the last API call. |
| `fmrl_redeem` | Trade a key code from fmrl.site for its key. |
| `fmrl_rotate` | Replace the key's secret. |

Arguments and edge cases for each tool are in [docs/tools.md](https://github.com/toogreatwtf/fmrl-plugin/blob/main/docs/tools.md).

## Keys and limits

Your key and key ring live in `~/.config/fmrl/credentials.json` (`%APPDATA%\fmrl\credentials.json` on Windows). Back that file up: it holds the keys to every private page you've published.

Each key gets 25 publishes a month, and a page can be up to 2 MiB (about 1.4 MB for a private page). Content follows fmrl.site's [acceptable use policy](https://fmrl.site/aup).

## Found a bug?

[Open an issue](https://github.com/toogreatwtf/fmrl-plugin/issues/new/choose), or write to support@fmrl.site if you don't have a GitHub account. The usual fixes are at [fmrl.site/install#help](https://fmrl.site/install#help).

## More

- [Configuration, keys and files](https://github.com/toogreatwtf/fmrl-plugin/blob/main/docs/configuration.md): environment variables, where things are stored, and using the API with curl.
- [Account vault ring sync](https://github.com/toogreatwtf/fmrl-plugin/blob/main/docs/vault-sync.md): how key rings are backed up to your fmrl account.
- [API reference](https://fmrl.site/api) on fmrl.site.
- [Contributing](https://github.com/toogreatwtf/fmrl-plugin/blob/main/CONTRIBUTING.md) and [releasing](https://github.com/toogreatwtf/fmrl-plugin/blob/main/RELEASING.md).

## License

MIT, Too Great LLC.
