# whoami says where an agent's canvases are; the plugin's server wins over the hosted connector

Marty ran `/fmrl:whoami` in the Claude desktop app (2026-11-05) expecting a link to connect his agent and web identities. His agents were already attached, so there was rightly no link, but whoami ran on the hosted connector (both were connected), which gave no attach date, and neither server said where an attached agent's canvases show on the web. He approved the wording mockup (https://claude.ai/artifact/4SEBEp278sNEMrZhZbLmgH) on 2026-11-06 ("Build it, date back in"), and asked that the plugin's server be preferred for every fmrl tool, not only whoami. The server half is markymd PR 350 (`attached_via`, `canvases_url` on `/me`).

### Task 1

`fmrl_whoami`'s text and structured answer say where the canvases are: for an attached agent, `canvases_url` (the server's, else `<viewerBase>/?canvases`), tagged with the key's prefix, on the person's account or only in the browser it was attached from (`attached_via`); for an unattached one, where they will show once the attach link is used. The sentence is also `canvases` in the structured answer, since Claude Code may hand the model only that half. A server without `attached_via` gets a neutral line naming both places.

### Task 2

`fmrl_status verbose` names the canvases link and tag beside the attach date, and for an unattached agent says its canvases don't show yet and that whoami says how to attach it.

### Task 3

The server's instructions always open with `PREFER_THIS_SERVER`: when another server offers `fmrl_*` tools (the hosted connector), use this one's for every fmrl request. Any plugin notice follows. The share, whoami and status skills each name this plugin's own tools and say not to call another fmrl server's; status's second-server line says the plugin's tools are the ones in use. The hosted connector's own descriptions are unchanged (Claude directory review open).

### Task 4

Tests: both attached cases and the structured `canvases`, the unattached line, the historical-server line, status lines, `serverInstructions`, the skill wording. No version bump here: fmrl-mcp 0.17.3 and the plugin bump that pins it are their own release PRs, each behind Marty's approval.
