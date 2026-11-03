# fmrl for ChatGPT

The package OpenAI's plugin directory takes: an Agent Plugins manifest (`plugin.json`), one remote MCP server (`mcp.json`, the hosted connector at `https://fmrl.site/mcp`), the `share` skill and the listing icons. It is the hosted, public-pages-only sibling of `plugins/fmrl`, which runs `fmrl-mcp` locally and also makes private pages.

## What it runs

Nothing on the person's machine. ChatGPT calls the hosted fmrl server at `https://fmrl.site/mcp` over streamable HTTP, signed in with OAuth: ChatGPT identifies itself by its Client ID Metadata Document, the person consents once on fmrl.site, and the connection is one named fmrl key. Eight tools: `fmrl_publish`, `fmrl_get`, `fmrl_watch`, `fmrl_inbox`, `fmrl_edit`, `fmrl_list`, `fmrl_whoami`, `fmrl_delete`.

## What it sends and stores

What the person asks to share goes to fmrl.site as a public page. fmrl.site keeps the page, its revisions and the key's usage; nothing is stored in the package. See https://fmrl.site/privacy.

## Building the ZIP

From the repo root:

```sh
packages/mcp/scripts/pack-chatgpt.sh
```

It writes `fmrl-chatgpt-<version>.zip` with `plugin.json` at the archive root. Bump `version` in `plugin.json` before each resubmission; the portal refuses an unchanged version.

## Filled in on the portal, not here

- The demo recording URL and the reviewer test account. Credentials never go in the ZIP.
- A justification for each tool's read-only, open-world and destructive hints, after the portal's tool scan.
- Countries, if the listing should be limited.
- Domain verification: the portal's token is served at `https://fmrl.site/.well-known/openai-apps-challenge` once `OPENAI_APPS_CHALLENGE` is set in the deployment.
