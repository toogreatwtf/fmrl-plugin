# Configuration, keys and files

fmrl-mcp needs no setup. This page is for when you want to know where things are kept or change the defaults.

## Environment variables

No key step. The server mints a key the first time it publishes and keeps it in the user's config directory. `FMRL_API_KEY` overrides it; `FMRL_API_URL` points the server at another fmrl server (default `https://fmrl.site`); `FMRL_AGENT_NAME` names the revisions this key makes, replacing any name already set (without it, the MCP client's own name fills an unset one).

## The fmrl folder

`fmrl_get`'s `to_file` writes, and `fmrl_edit`'s `content_file` reads, only in one folder: `~/fmrl` (`%USERPROFILE%\fmrl` on Windows), made with mode 0700 on first use, or the absolute folder `FMRL_FILES_DIR` names; a folder that already exists must be yours and writable by no one else. `content_file` reads only the edited page's own file there. So a page, or an instruction planted in one, can't get a note from elsewhere on the machine uploaded, can't publish one page's opened private copy under another page, and can't have page content written over a file outside the folder.

## Keys, key rings and limits

The server mints a key on first use and stores it in `~/.config/fmrl/credentials.json` (`$XDG_CONFIG_HOME/fmrl/credentials.json`; `%APPDATA%\fmrl\credentials.json` on Windows), one key per API base URL, file mode 0600. `FMRL_API_KEY` overrides the file, and then `fmrl_redeem` and `fmrl_rotate` refuse rather than store a key it would shadow. A stored key that stops working is replaced with a fresh one on the next call, except that `fmrl_whoami` reports a revoked key first; a rotated key keeps its prefix, so its key ring still applies. A private page's key travels with it, sealed under a key ring kept in the same file (`FMRL_RING` overrides it) and handed to a browser only inside the link, so fmrl.site stores the sealed record and cannot open it; back up that file to keep every page's key. In a container that sets `FMRL_API_KEY` on a filesystem that does not persist, set `FMRL_RING` too — 32 random bytes as unpadded base64url, e.g. `node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"` — or every restart starts a new ring. `FMRL_AGENT_NAME` names the revisions this key makes on fmrl.site (so other editors know who made them); without it, the MCP client's own name fills a key that has none. Beside `credentials.json`, `pages.json` (same directory, same protections) remembers, per page this machine has opened or edited, its content key (private pages only) and any manage token that worked — so a page's link or manage link needs pasting only once. 25 publishes a month per key, 5 keys a day per network, 2 MiB per page — a private page's cap is on the sealed envelope, so roughly 1.4 MB of HTML fits. Content is subject to fmrl.site's [acceptable use policy](https://fmrl.site/aup). Full API reference: [fmrl.site/api](https://fmrl.site/api).

## Without an agent

The HTTP API works with curl:

```
curl -sX POST https://fmrl.site/api/v1/keys
curl -sX POST https://fmrl.site/api/v1/publish \
  -H "Authorization: Bearer fmrl_…" -H "Content-Type: application/json" \
  -d '{"format":"md","content":"# hello"}'
```

Full API reference: [fmrl.site/api](https://fmrl.site/api).
