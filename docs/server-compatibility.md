# Server compatibility

Notes for maintainers on how fmrl-mcp talks to both the legacy fmrl.site API (browser links) and the identity API (attach links). Users don't need any of this.

The compatibility bridge accepts both legacy browser-link fields (`linked_at`,
`link_url`, and older editor `name`) and identity fields (`attached_at`,
`attach_url`, `label`/`display_name`, and publish `recovery`). Linking a browser is
not reported as attaching an identity. A missing recovery state is unknown;
spent or revoked links are not advertised as usable or saved for later edits.
Legacy management links keep their existing local token handling. The bridge
never opens a recovery link to find a page or replaces an attach link automatically.

Courtesy attach links seen during setup, status probes, or vault checks stay in
process memory per API origin and credential for at most one hour. Publish and
whoami can show that previously supplied link with the local ring fragment. A
reported attachment clears it. Restarting loses this cache; another process or a
replacement link can also make a cached link unusable. No capability is persisted
or minted to repair that situation.

HTTP responses are projected onto closed MCP schemas; declared fields still
validate. A successful publish with an invalid response, or a timeout with an
uncertain outcome, must not be automatically republished. Use `fmrl_list` and the
saved page information to reconcile first. Publish idempotency remains absent:
this client sends no `Idempotency-Key`.
