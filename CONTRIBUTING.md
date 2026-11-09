# Contributing

## Development

```
cd packages/mcp && npm install && npm test && npm run build
claude --plugin-dir ./plugins/fmrl    # from the repo root; npm link in packages/mcp first so npx finds the local build
```

Open pull requests as drafts and mark them ready when `npm test` in `packages/mcp` is green. The `test` workflow (`.github/workflows/test.yml`) runs the same suite and build on every PR and on `main`, on Node 20 and 22.

## Repository layout

- `packages/mcp`: the fmrl-mcp server, published to npm. Its `README.md` is the npm page; keep it the same as the root README.
- `plugins/fmrl`: the Claude Code and Cursor plugin, which runs a pinned fmrl-mcp.
- `plugins/fmrl-chatgpt` is the package for OpenAI's plugin directory: the hosted connector at `https://fmrl.site/mcp` (public pages only) with its own share skill, nothing run locally. `packages/mcp/scripts/pack-chatgpt.sh` zips it for the portal, and `test/chatgpt-package.test.ts` holds it to the portal's limits; its README lists what is filled in on the portal instead.

Releasing is in [RELEASING.md](RELEASING.md).
