# Private canvas renderer assets

These files are copied from toogreatwtf/markymd, whose public renderer is the source of truth:

- `canvas.wasm.gz`: `static/canvas.wasm.gz`, built from `cmd/canvas-wasm` and `internal/render.CodeHTML` by `go run ./cmd/canvas-assets`.
- `canvas-assets.json`: `static/canvas-assets.json`, containing the public canvas stylesheet and unmodified `internal/render/copy.js`, plus source and binary hashes.
- `wasm_exec.cjs`: the generating Go toolchain's `lib/wasm/wasm_exec.js` (Go version is recorded in `canvas-assets.json`). The extension selects CommonJS for Node; the contents are unchanged.

The highlighter initializes lazily on the first language-labelled fence, in process, with no network call. Markdown stays on marked; only code tokenization uses the same Chroma and shell-role mapping as public pages. Generated HTML is highlighted before sealing and carries its CSS and copy script, so viewing a private page downloads no highlighter.

To update, regenerate in markymd, copy all three files above, copy both `heading-ids.json` and `canvas-parity.json` to `test/fixtures`, and run `npm test`, `npm run build`, and `npm run check:fixtures`. The upstream check intentionally requires markymd to merge first. Because markymd is private, the plugin repository must also configure `MARKYMD_FIXTURES_TOKEN` with read-only Contents access to that repository; the ordinary repository-scoped Actions token cannot read a sibling private repository. Never copy a developer's local credential into the repository. Any semantic renderer change requires regeneration; do not hand-edit generated assets.

The compressed module is about 2.3 MB (9.2 MB expanded), with roughly 73 ms initialization in a local Node 22 measurement. This trades download size on private-page creation/edit for exactly the public renderer's language support and roles. There is no impact on public-page creation or on readers.

Before merging code-copy changes, Marty must click a private code-copy button in real Safari and Firefox. Playwright's selection-only copy guard is necessary, but its bundled engines do not establish this manual gate.

Third-party Go runtime, Chroma, regexp2 and goldmark notices are in `THIRD-PARTY-LICENSES.txt`. markymd is licensed under its repository license.
