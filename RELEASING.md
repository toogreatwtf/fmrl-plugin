# Releasing

A release is two pull requests: one publishes a new fmrl-mcp to npm, the next points the plugin at it.

## Why two

`plugins/fmrl/.mcp.json` and `plugins/fmrl/mcp.json` run `npx -y fmrl-mcp@<x.y.z>`, pinned to one exact version, because Claude's plugin directory blocks a launcher that runs whatever npm has newest. So a new server reaches a plugin user only when their plugin updates to a version that names it. Anyone who added fmrl-mcp to an MCP config by hand still runs the latest on their next start. Merging the pin before the publish would leave new installs unable to start the server.

## Steps

1. Make the change, and run `npm version <x.y.z> --no-git-tag-version` in `packages/mcp`. Merge it, and a maintainer approves the publish.
2. Once npm has that version, move the pin in both `mcp.json` files to it and bump `plugins/fmrl/.claude-plugin/plugin.json` and `plugins/fmrl/.cursor-plugin/plugin.json`. The Claude manifest tracks the pinned server on major.minor, the Cursor manifest matches the Claude one exactly, and the test suite checks that they agree.

## What the release workflow does

The `release` workflow (`.github/workflows/release.yml`) runs on every merge to `main` that touches `packages/mcp`.

- When `packages/mcp/package.json` names a version npm does not have yet, it publishes it through npm Trusted Publishing (GitHub OIDC, no token in secrets, a provenance attestation back to the commit).
- The publish runs only for `main` and waits for a maintainer's approval, so a merge alone never ships to every installed plugin.
- Once npm has the version, the same approved job lists it in the official MCP Registry as `io.github.toogreatwtf/fmrl-mcp` from `packages/mcp/server.json`, logging in with GitHub OIDC.
- npm and the registry are checked separately. A version that is on npm but not yet listed is listed by re-running the workflow, or running it by hand on `main`, and approving it.
- After the publish, it tags the version as `v<x.y.z>` on the commit npm recorded for it and writes a GitHub Release whose notes list the PRs that touched `packages/mcp` since the previous version. The same notes are on the run's summary page while the publish waits for approval.
- When npm and the registry both already have the version, it finishes green without asking for approval. A merge that only changes docs under `packages/mcp` ships nothing.

## Tagging a version by hand

The `tag release` workflow (`.github/workflows/tag-release.yml`) can be run from the Actions tab with a version, to tag and write the release for one that's already on npm, such as those published before tagging was automatic. It leaves a version that already has a release alone and never moves an existing tag.
