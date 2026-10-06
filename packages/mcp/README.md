# fmrl

Share anything your AI made. `fmrl` is a Claude Code plugin and an MCP server (`fmrl-mcp`) that publish a page to [fmrl.site](https://fmrl.site) and hand back a link. No account; the page lasts seven days unless someone keeps it from the page itself — a private page cannot be kept.

## Install

Claude Code:

```
/plugin marketplace add toogreatwtf/fmrl-plugin
/plugin install fmrl@fmrl-plugin
```

Keep it current: auto-update is your switch — no marketplace can set it for you. The plugin offers once to turn it on; you can flip it yourself in /plugin → Marketplaces → fmrl-plugin → Enable auto-update. In the Claude desktop app the switch does nothing: update by hand, or when the plugin says it is out of date. By hand: claude plugin marketplace update fmrl-plugin, then claude plugin update fmrl@fmrl-plugin, and restart Claude Code.

Any MCP client (Claude Desktop, Cursor, Codex, Windsurf, and the rest):

```json
{ "mcpServers": { "fmrl": { "command": "npx", "args": ["-y", "fmrl-mcp"] } } }
```

No key step. The server mints a key the first time it publishes and keeps it in the user's config directory. `FMRL_API_KEY` overrides it; `FMRL_API_URL` points the server at a preview or a local `make dev` (default `https://fmrl.site`); `FMRL_AGENT_NAME` names the revisions this key makes, replacing any name already set (without it, the MCP client's own name fills an unset one).

curl, for people who want neither:

```
curl -sX POST https://fmrl.site/api/v1/keys
curl -sX POST https://fmrl.site/api/v1/publish \
  -H "Authorization: Bearer fmrl_…" -H "Content-Type: application/json" \
  -d '{"format":"md","content":"# hello"}'
```

## What you get

In Claude Code, `/fmrl:share` publishes what is at hand — a file you named or something the agent composed — and replies with the link, the expiry, and a manage link that removes the page. Before publishing a canvas that hands work to someone else to review, it offers the `handoff-review` starter — eight sections and a `fmrl-profile` block recording their shape, readable at [fmrl.site/h4ndrv](https://fmrl.site/h4ndrv). `/fmrl:whoami` shows the key, this month's quota, where the key ring is kept, and whether the plugin is up to date.

Any MCP client gets eleven tools:

| Tool | Does |
|---|---|
| `fmrl_publish` | `content`, optional `format` (`html` or `md`; detected when left out), optional `title`, optional `private` (encrypts the page here before upload; the link carries the key after `#p=`) → the page's URL, expiry and manage link, plus a one-time browser link, carrying the key ring after `#r=`, until a browser is linked to the key |
| `fmrl_publish_file` | `path` to a `.html`, `.htm`, `.md`, `.markdown`, `.mdx` or `.txt` file (2 MiB at most), optional `title`, optional `private` (encrypts the page here before upload; the link carries the key after `#p=`) → the same as `fmrl_publish` |
| `fmrl_get` | an id or any fmrl.site link (may carry a page key after `#p=` and a manage token after `#k=`), optional `rev` (the latest when left out) → status, format, size, expiry, whether it was kept, plus that revision's content and who made it; a private page opens with the key in the link or one already held here. Reading a revision of a page you watch marks it seen. A page carrying a `fmrl-profile` block also returns its parsed profile and which heading holds each section |
| `fmrl_edit` | id or link, `content`, optional `format`, `title`, `base_rev` (the revision you read from; the edit fails if someone saved a newer one) → the new revision's number and link, and whether the page is now watched (an edit watches it, so replies show up in `fmrl_inbox`). Works on pages this key owns and on any page whose manage link you were given; a private page stays under its same key |
| `fmrl_watch` | id or link → watches the page so revisions other editors make show up in `fmrl_inbox`; a private page's key is remembered here once it opens the page. For a page you read and do not edit: pages you publish or edit are watched already |
| `fmrl_inbox` | nothing → pages you watch that someone else has revised since you last read them, newest first; read each with `fmrl_get`, which marks it seen |
| `fmrl_list` | nothing → every page this key owns, newest first (50 at most); a private page with its title and keyed link when this machine holds the key ring |
| `fmrl_delete` | an id or a viewer URL → removes a page this key published |
| `fmrl_whoami` | optional `trust_vault` (the exact grouped vault fingerprint the person explicitly confirmed on `/account`) → the key's prefix, this month's quota, whether it is named and by what, whether a browser is linked to it, a fresh link to link one when the server offers it (carrying the key ring after `#r=`), when its secret was last rotated, where the key ring is kept, and, when the Claude Code plugin launched it and its manifest reads, whether that plugin is up to date; supplied account-vault sync and fingerprint notices. A revoked key is reported, not replaced, with how to get a new one |
| `fmrl_redeem` | `code`, a key code from the fmrl.site keys page (26 letters and digits in groups of four; dashes, spaces and case don't matter) → trades it for the key it carries, once, and saves that as this machine's key. A key rotated from a browser reaches its agent this way; say "Redeem my fmrl key code …" |
| `fmrl_rotate` | nothing → replaces the key's secret and saves the new one; the old secret stops working at once, and the prefix, pages, name, quota, linked browsers, connected apps and key ring stay |

## Keys and limits

The server mints a key on first use and stores it in `~/.config/fmrl/credentials.json` (`$XDG_CONFIG_HOME/fmrl/credentials.json`; `%APPDATA%\fmrl\credentials.json` on Windows), one key per API base URL, file mode 0600. `FMRL_API_KEY` overrides the file, and then `fmrl_redeem` and `fmrl_rotate` refuse rather than store a key it would shadow. A stored key that stops working is replaced with a fresh one on the next call, except that `fmrl_whoami` reports a revoked key first; a rotated key keeps its prefix, so its key ring still applies. A private page's key travels with it, sealed under a key ring kept in the same file (`FMRL_RING` overrides it) and handed to a browser only inside the link, so fmrl.site stores the sealed record and cannot open it; back up that file to keep every page's key. In a container that sets `FMRL_API_KEY` on a filesystem that does not persist, set `FMRL_RING` too — 32 random bytes as unpadded base64url, e.g. `node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"` — or every restart starts a new ring. `FMRL_AGENT_NAME` names the revisions this key makes on fmrl.site (so other editors know who made them); without it, the MCP client's own name fills a key that has none. Beside `credentials.json`, `pages.json` (same directory, same protections) remembers, per page this machine has opened or edited, its content key (private pages only) and any manage token that worked — so a page's link or manage link needs pasting only once. 25 publishes a month per key, 5 keys a day per network, 2 MiB per page — a private page's cap is on the sealed envelope, so roughly 1.4 MB of HTML fits. Content is subject to fmrl.site's [acceptable use policy](https://fmrl.site/aup). Full API reference: [fmrl.site/api](https://fmrl.site/api).

## Account vault ring sync

Sharing requires no account. When a key belongs to an account with private-page sync enabled, the local MCP server seals credential-file rings to the advertised account vault. Every successful public or private `fmrl_publish` or `fmrl_publish_file` makes a fresh `GET /api/v1/me` after publishing; every `fmrl_whoami` uses its own fresh response and syncs too. Nothing about the vault goes through the hosted `/mcp` endpoint.

The server validates the vault public key and recomputes its fingerprint before pinning it on first use (TOFU). Pins are stored per viewer origin in `credentials.json`, still version 1, with additive `vault_pins` alongside existing keys and rings. Historical slots now also record `ring_origins`, a locally established origin for each ring. A changed fingerprint stops uploads until the person explicitly confirms the fingerprint on `/account` and supplies that exact grouped value through `fmrl_whoami`'s optional `trust_vault`. The agent must never trust a changed fingerprint automatically.

Only rings with local provenance for the configured origin are eligible: stored keys under that origin (including URL aliases), and historical slots whose `ring_origins` entry names it. Legacy history with no origin stays on disk and is excluded unless its exact prefix/ring pair matches a same-origin stored key. A server advertising a matching prefix cannot authorize exporting another origin's ring. This reduces recovery coverage for unscoped legacy rings; they require the original backup until an explicit migration is available.

The actual active ring, if eligible and stored in the credentials file, goes first in its own request. Superseded variants under that active prefix remain local and are not uploaded, preventing them from exhausting the budget or overwriting the active box. Other eligible prefixes retain numeric historical order with stored-key variants last. The vault retains one box per prefix, so it cannot recover every historical variant.

Each `PUT /api/v1/me/rings` contains at most 50 boxes and no repeated prefix. Requests share the edit budget (`API_EDITS_PER_HOUR`, default 60/hour), not the publish quota. On atomic HTTP 400 rejection, the client tries each member of a multi-row batch once separately and continues other prefixes; a refused singleton is not retried. The active request costs one edit; isolating a refused N-row batch costs up to 1+N requests. Each pass is capped at 60 PUT attempts and stops immediately on 429 or any other operational failure. The next authorized tool call starts afresh; there is no throttle, boxed-ring cache or background timer. HTTP 403/409 refusals remain silent. Refused, unfinished or partially uploaded requested scope is unknown and produces no synced/not-synced claim. Malformed vault data, persistence failures and network/5xx failures preserve the original tool success and log a fixed non-secret diagnostic. A primary whoami `/me` failure retains its normal error/revocation behavior.

`FMRL_RING` is never added to the file snapshot. An environment-only or different override excludes stale file variants for the active prefix and omits a sync-status claim based on those uploads. An unavailable vault may still report the approved not-synced status. An override identical to an eligible stored active-prefix ring can qualify for the approved synced line after successful upload. An empty collection still sends one empty batch, but cannot establish synced status. Keep backing up the credentials file and any `FMRL_RING` value: unknown-origin history, superseded variants and unclaimed keys may still require the original backup, a keyed link or a browser that already holds the ring.

Production code only seals ring boxes; it has no vault opener or vault private-key input. The server receives sealed boxes, never plaintext rings, vault private keys, recovery codes or PRF outputs. Local tool output omits account IDs and vault material, while retaining approved grouped fingerprint notices and the existing browser `#r=` and private-page `#p=` links.

## License

MIT, Too Great LLC.
