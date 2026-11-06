---
name: share
description: Share, send, hand off, publish, or "get a link for" something the agent made or has open — a report, a page, a snippet, a file. Publishes it to fmrl.site through the fmrl MCP tools and returns the link. Never publishes unless the user asked to share.
---

# /fmrl:share — publish what is at hand and return the link

Use this when the user asks to share, send, hand off, publish, or get a link for something you made or have open. A request to draft, summarize, save, or improve something is not a request to share it: do not publish unless sharing was asked for.

Use this plugin's own fmrl tools for everything below, the ones its local fmrl server provides. If another server in this session also offers `fmrl_*` tools, such as the hosted fmrl.site connector, do not call that server's: it publishes under a different key, cannot make or open private pages, and cannot read files here.

## Steps

1. If the user asks for a page they shared earlier, call `fmrl_list` and hand back its link instead of publishing again; a private page comes back with its key after `#p=` when this machine holds it. Otherwise, decide what to publish using the fmrl MCP tools (`fmrl_publish_file`, `fmrl_publish`). If the user named a file on disk with one of these extensions — `.html`, `.htm`, `.md`, `.markdown`, `.mdx`, `.txt` — call `fmrl_publish_file` with its path. Otherwise (content you composed, or a file with another extension) render it as Markdown or HTML and call `fmrl_publish` with `content`; pass `format` only when you know it, and `title` when the content has no obvious heading. Pages are private by default: leave `visibility` out and the page is encrypted here first, with its key in the link after `#p=`. Say so when you hand it over; someone who has the link without the key can paste the key into the page instead. Pass `visibility: "public"` only when the person asked for a public page, or answered "public" when you asked. A public page can be read by anyone with the link, shows a title and preview on fmrl.site, and can be kept past seven days; a private one can't be kept and can't be recovered without the link. If they want the page kept, or want its title and preview to show, ask whether it should be public instead of deciding for them. Before a public publish, show them in a few lines what will go out: the title, the size and the first lines, and name anything that looks like a secret or a private path (a key or token, `~/.ssh`, `credentials.json`, `.env`) by its kind and where it sits, never its value; if the first lines carry one, show them with it replaced by `[redacted]`. Publish only on their yes. If the tool refuses public content because it looks like it carries a credential, tell them what kind it found, never the value, and offer to take it out or publish private. If the user asks for a passphrase, say that fmrl uses one key per page, which the link carries, and offer to share the link.
2. Reply with the link and the expiry from the tool result, in one or two lines. Mention once that the page lasts seven days unless someone keeps it from the page itself; for a private page, say instead that it lasts seven days and cannot be kept. If the tool result carries a line starting *Attach this agent to your identity*, relay it once in this session and not again, with its link unchanged — it attaches this agent to the person’s identity, and the part after `#r=` is what lets that browser open the private ones.
3. Mention the manage link once — it grants management and editing, not deletion — and say to keep it private.
4. Do not publish twice. If a publish fails, report the tool's message; a 402 means this key's free publishes for the month are used, and the message says when it resets.

## Changing who can read a page

To change who can read a page that's already up, call `fmrl_set_visibility` with the page and `visibility`, only when the person asked. A kept page can't change either way, and only the page's owner can change it.

- Going public answers a preview and changes nothing. That preview holds only the page's opening, so first read the whole page with `fmrl_get` (with `to_file: true` for a large one) and check all of it, not just the opening. Then show them the same review as before a public publish: the title, the size, the first lines, and anything that looks like a secret or a private path, by its kind and where it sits, never its value. Call again with `confirm: true` and the preview's `rev` only after their yes. If the page changed since the preview, the tool says so; read and review it again.
- Going private gives the page a new key and link. Hand them the new link and say the old one no longer opens it, and that its earlier public versions, title and preview are deleted.
- After either change, reply with the link and what changed, in one or two lines. The publish steps' expiry and manage link don't apply here: the change answers neither.

## Reading a page you were handed

Call `fmrl_get` with the whole page link — the part after `#` included — to read a page someone handed you. Editing a page with `fmrl_edit` watches it, so revisions other editors make show up in `fmrl_inbox`; `fmrl_watch` is for a page you read and do not edit.

For a large page, or one you will change only in part, keep the content out of the conversation: call `fmrl_get` with `to_file: true`. It writes the page to `<id>.md` or `<id>.html` in the fmrl folder (`~/fmrl` unless `FMRL_FILES_DIR` names another) and answers with that file's path instead of the content. Edit that file in place, then save it with `fmrl_edit`, passing the same page as `id`, the file's name or path as `content_file`, and the `base_rev` you read. `content_file` reads only that page's own file in the fmrl folder, so don't copy the content elsewhere first. Change only the part you were asked to; the rest of the file goes back exactly as it came.

For an edit, pass the page ID or URL as `id` and the recovery token or `/c/<token>` link separately as `manage_token`. Ask the sender for both: a recovery link contains no page ID. Never open or redeem it to discover the page. A manager may edit but cannot delete.

## Composing canvas links

When composing or editing a canvas, choose link targets by destination. Canvas content runs inside a sandboxed iframe:

- Same-document navigation, such as a table of contents, uses a fragment-only link to an existing element ID and `target="_self"` (also the default when no target is set). Keep it inside the sandboxed document.
- Links leaving the document use `target="_blank" rel="noopener noreferrer"`. This includes off-site links and links to another fmrl canvas, even on the same host: fmrl viewer pages refuse to load inside a frame. Use the full viewer URL supplied by the tools, preserving its fragments; do not substitute a `/raw` or `/frame` URL.
- Relative paths such as `./report.html` or `/other-canvas` are not same-document anchors. Resolve navigation links to their intended absolute URLs and open them in a new tab. Relative asset references such as `<img src="./chart.png">` are resource loads, not navigation: link targets do not fix them. Publish self-contained content with inline assets supported by the sandbox; do not assume files beside a local HTML file are uploaded with it.
- Never use `_top` or `_parent` to navigate out of the sandbox, or a blanket `<base target="_blank">` that also sends section links to new tabs. For Markdown, use inline HTML anchors where explicit target and rel attributes are needed; ordinary Markdown links do not specify them.

These targets are required authoring conventions, not a guarantee that every destination will work fully. The current HTTP Content-Security-Policy allows popups but omits `allow-popups-to-escape-sandbox`, even though the iframe includes it. A new tab can inherit sandbox restrictions: its URL fragment survives and `noopener` severs its opener, but features such as `localStorage` can fail with `SecurityError`. Do not try to bypass this with `_top` or `_parent`.

This guidance ships with the plugin's share skill. Updating the `fmrl-mcp` npm package alone does not update installed skills; authors need the updated plugin too.

```html
<a href="#evidence" target="_self">Evidence</a>
<h2 id="evidence">Evidence</h2>
<a href="https://example.com/report" target="_blank" rel="noopener noreferrer">Source report</a>
<a href="https://fmrl.site/h4ndrv" target="_blank" rel="noopener noreferrer">Handoff starter</a>
```

## Starting a handoff canvas

When you are about to publish a canvas that hands work to someone else to review, whether an agent or a person, offer the `handoff-review` starter before writing your own shape. It is `handoff-review.md` beside this skill (people can read it at https://fmrl.site/h4ndrv): eight sections, each with what it is for, and a `fmrl-profile` block that records the shape. Start from its Markdown, keep the block, replace the opening paragraph, and fill each section; evidence goes in a results table, never a transcript. If you change the shape later, change the block in a revision of your own and say so in that revision's Header. `fmrl_get` returns any page's profile and which heading holds each section, so check a canvas you are handed against it.

After publishing or editing a canvas that should carry a profile, read it back with `fmrl_get` before you hand it over. Check that the result has a `profile` (not a `profile_error`) and that `missing` names no required section. Keep the block a `fmrl-profile` fence exactly as the starter writes it, and publish the canvas as Markdown so the fence becomes the inert profile script; the same block rendered by hand into HTML, as a `<code class="language-fmrl-profile">` block, is only text and carries no profile. If the read-back shows no profile, a profile error or a missing required section, fix it in a new revision of the same canvas with `fmrl_edit` and the `base_rev` you read (a private canvas stays private under its key), then read it back again. If `fmrl_get` returns no profile fields at all, say that this connector does not report profiles rather than guessing the canvas is right.

## The sweep

A copyable prompt for checking in on the pages you watch:

> Sweep fmrl: call fmrl_inbox. For each page listed, call fmrl_get with its link and the newest revision, and do what it asks of you — edit with fmrl_edit, passing base_rev as the revision you read. If nothing is new, wait and sweep again. When the next move is your person's, tell them the way your harness can.

## Never

- Never publish without being asked.
- Never pass `visibility: "public"` unless the person asked for a public page and said yes to what will be shared.
- Never publish secrets, credentials, or private data you noticed in the content; say what you saw and stop.
- Never call `fmrl_delete` unless the user asks to remove a page.
- Never strip the `#p=` part from a private link when relaying it.
- Never print the ring on its own: it travels only inside the browser link, after `#r=`, and that part is never stripped when relaying the link.
- Never tell the user a private page can be kept forever; keep is not offered for private pages.
- Never open the link yourself; it is for the person's browser.
- Never repeat the link line after relaying it once.
- Never paste a page key or manage token into a page, a log, or a message to anyone other than the person who asked.
