---
name: attach
description: Attach this agent to the person's fmrl account, so its pages show in their canvases on fmrl.site. Gets a one-time link, good for 10 minutes, and a short code to compare on the page; when the agent is already attached, mints no link and only names its machine in the person's account. Use when the user asks to attach, connect or link this agent (or Claude Code, Codex, Cursor) to their fmrl account, optionally naming the machine ("attach claude code on prodigal").
---

# /fmrl:attach — attach this agent to your fmrl account

Use this plugin's own fmrl tools, the ones its local fmrl server provides. If another server in this session also offers `fmrl_*` tools, such as the hosted fmrl.site connector, do not call that server's: only this plugin's server holds this machine's key and ring.

1. Call this plugin's `fmrl_attach` once. If the person named a machine ("on prodigal"), pass it as `machine`, in their spelling; otherwise leave `machine` out and the tool uses this computer's name.
2. When the answer says the agent is already attached, relay that line and stop. There is no link to give, by design. The tool has already named this machine in the person's account if it needed naming; the line says so when it did.
3. Otherwise reply with the tool's lines, in order: the sentence naming the agent and machine, the link exactly as given (with its whole `#r=` fragment), the code, and how long the link lasts. Tell the person to open it in the browser where they use fmrl, check the code matches, and press Attach.
4. If the call fails or the key is revoked, relay the tool's message and its recovery guidance.

## Never

- Never open the link yourself, shorten it, or drop its fragment; it is for the person's browser.
- Never print the ring on its own, a full API key, or credentials-file contents.
- Never call `fmrl_attach` again to "refresh" a link the person has not used: each call ends the earlier link.
- Never attach unless the person asked to.
