# whoami: no "missing attach link" once attached

Marty ran `/whoami` in Cursor (2026-10-31) after installing the plugin. The tool reported the agent attached on 2026-10-18, and the reply then said no attach link was supplied and not to invent one; he had seen that line in other sessions too and read it as the attach step failing. It isn't: `fmrl_whoami` drops `attach_url` once `attached_at` has a date, because attaching happens once per key. The skill's step 6 ("If no attach link is supplied, relay that fact") made the model say so anyway. Cursor also needed the full repository address in Import Marketplace; the short `owner/repo` form gave `[invalid_argument] Error`.

### Task 1

The whoami skill says an attach link comes only while the agent is unattached, that an attached agent's reply says so with its date and nothing about a missing link, and keeps the existing rule for an unattached agent with no link. No server change.

### Task 2

Both READMEs give Cursor's real steps: Customize, Plugins, Add, Import Marketplace, and the full `https://github.com/toogreatwtf/fmrl-plugin` address. This comes after the Cursor plugin (PR 36) and before markymd's install page follows it (PR 314).

### Task 3

`test/plugin-files.test.ts` checks the new skill wording and the new README step. No version bump here: a skill-only change reaches installed plugins with the next release's version bump, which stays behind its own approval.
