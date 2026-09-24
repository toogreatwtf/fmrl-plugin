# fmrl

Share anything your AI made. `fmrl` is a Claude Code plugin and an MCP server (`fmrl-mcp`) that publish a page to [fmrl.site](https://fmrl.site) and hand back a link. No account; the page lasts seven days unless someone keeps it from the page itself — a private page cannot be kept.

## Install

Claude Code:

```
/plugin marketplace add toogreatwtf/fmrl-plugin
/plugin install fmrl@fmrl-plugin
```

Keep it current: Claude Code leaves auto-update off for marketplaces outside Anthropic's own, and a marketplace cannot turn it on for its users — the switch is yours. The plugin offers once, the first time it sees the switch off, to set it for you; you can also flip it yourself in /plugin → Marketplaces → fmrl-plugin → Enable auto-update. Either way it takes effect at the next Claude Code start, and an update lands on the start after the one that fetches it, so a long-running session can still be a release behind — /fmrl:whoami says which version you have and whether anything is keeping it current. To update by hand: claude plugin marketplace update fmrl-plugin, then claude plugin update fmrl@fmrl-plugin, and restart Claude Code.

Any MCP client (Claude Desktop, Cursor, Codex, Windsurf, and the rest):

```json
{ "mcpServers": { "fmrl": { "command": "npx", "args": ["-y", "fmrl-mcp"] } } }
```

No key step. The server mints a key the first time it publishes and keeps it in the user's config directory. `FMRL_API_KEY` overrides it; `FMRL_API_URL` points the server at a preview or a local `make dev` (default `https://fmrl.site`).

curl, for people who want neither:

```
curl -sX POST https://fmrl.site/api/v1/keys
curl -sX POST https://fmrl.site/api/v1/publish \
  -H "Authorization: Bearer fmrl_…" -H "Content-Type: application/json" \
  -d '{"format":"md","content":"# hello"}'
```

## What you get

In Claude Code, `/fmrl:share` publishes what is at hand — a file you named or something the agent composed — and replies with the link, the expiry, and a manage link that removes the page. `/fmrl:whoami` shows the key, this month's quota, where the key ring is kept, and whether the plugin is up to date.

Any MCP client gets six tools:

| Tool | Does |
|---|---|
| `fmrl_publish` | `content`, optional `format` (`html` or `md`; detected when left out), optional `title`, optional `private` (encrypts the page here before upload; the link carries the key after `#p=`) → the page's URL, expiry and manage link, plus a one-time browser link, carrying the key ring after `#r=`, until a browser is linked to the key |
| `fmrl_publish_file` | `path` to a `.html`, `.htm`, `.md`, `.markdown`, `.mdx` or `.txt` file (2 MiB at most), optional `title`, optional `private` (encrypts the page here before upload; the link carries the key after `#p=`) → the same as `fmrl_publish` |
| `fmrl_get` | an id or a viewer URL → status, format, size, expiry, whether it was kept; for a private page this key owns, its title and its link with the key after `#p=` |
| `fmrl_list` | nothing → every page this key owns, newest first (50 at most); a private page with its title and keyed link when this machine holds the key ring |
| `fmrl_delete` | an id or a viewer URL → removes a page this key published |
| `fmrl_whoami` | the key's prefix, this month's quota, whether a browser is linked to it, a fresh link to link one when the server offers it (carrying the key ring after `#r=`), where the key ring is kept, and, when the Claude Code plugin launched it and its manifest reads, whether that plugin is up to date |

## Keys and limits

The server mints a key on first use and stores it in `~/.config/fmrl/credentials.json` (`$XDG_CONFIG_HOME/fmrl/credentials.json`; `%APPDATA%\fmrl\credentials.json` on Windows), one key per API base URL, file mode 0600. `FMRL_API_KEY` overrides the file. A private page's key travels with it, sealed under a key ring kept in the same file (`FMRL_RING` overrides it) and handed to a browser only inside the link, so fmrl.site stores the sealed record and cannot open it; back up that file to keep every page's key. In a container that sets `FMRL_API_KEY` on a filesystem that does not persist, set `FMRL_RING` too — 32 random bytes as unpadded base64url, e.g. `node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"` — or every restart starts a new ring. 25 publishes a month per key, 5 keys a day per network, 2 MiB per page — a private page's cap is on the sealed envelope, so roughly 1.4 MB of HTML fits. Content is subject to fmrl.site's [acceptable use policy](https://fmrl.site/aup). Full API reference: [fmrl.site/api](https://fmrl.site/api).

## Development

```
cd packages/mcp && npm install && npm test && npm run build
claude --plugin-dir ./plugins/fmrl    # from the repo root; npm link in packages/mcp first so npx finds the local build
```

Pull requests open as drafts and are marked ready when `npm test` in `packages/mcp` is green; the `test` workflow (`.github/workflows/test.yml`) runs the same suite and build on every PR and on `main`, on Node 20 and 22. CodeRabbit runs on a metered allowance and `.coderabbit.yaml` skips drafts and reviews only when a PR opens or is marked ready, never on each push, so one review is spent per PR (none for `docs:` titles) and one more on `@coderabbitai review` after fixes.

## License

MIT, Too Great LLC.
