# /fmrl:attach: attach this agent from the agent

Marty, 2026-11-06: "`/attach claude code on prodigal` -> replies with a url -> url opens your account on fmrl with a prompt to attach the agent. If already attached, it's a noop." Mockups approved on the "fmrl attach command" design canvas. Server side: markymd #355.

### Task 1

`FmrlApi.attach(key, machine)` posts `{"machine": …}` to `POST /api/v1/me/attach`. A link answer replaces the in-process attach hint for the link's own lifetime (ten minutes, capped at an hour), since the server ends the earlier unspent link; an attached answer clears it.

### Task 2

`fmrl_attach` (optional `machine`, defaulting to the host name's first label): the link with the key ring after `#r=` when this machine holds one, the code, the machine, and "It works once, for 10 minutes"; an attached agent gets "already attached … Nothing to do." and no link. A server from before #355 answers no code: the text then omits the code line. A revoked key is reported as whoami reports it.

### Task 3

The `/fmrl:attach` skill: call the tool once (with the machine the person named), relay the link and code unchanged, never open the link, never re-call to refresh. Manifests, READMEs and counts name the new skill and tool (the counts were already one short: `fmrl_set_visibility`).

### Task 4

Tests: the tool's link, ring, code and machine, the request body, the no-op, the default machine name, `machineName`, and the hint replacement. No version bump: fmrl-mcp's release and the plugin pin are their own PR, behind Marty's approval, after #355 is live.
