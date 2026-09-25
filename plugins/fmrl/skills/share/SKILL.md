---
name: share
description: Share, send, hand off, publish, or "get a link for" something the agent made or has open — a report, a page, a snippet, a file. Publishes it to fmrl.site through the fmrl MCP tools and returns the link. Never publishes unless the user asked to share.
---

# /fmrl:share — publish what is at hand and return the link

Use this when the user asks to share, send, hand off, publish, or get a link for something you made or have open. A request to draft, summarize, save, or improve something is not a request to share it: do not publish unless sharing was asked for.

## Steps

1. If the user asks for a page they shared earlier, call `fmrl_list` and hand back its link instead of publishing again; a private page comes back with its key after `#p=` when this machine holds it. Otherwise, decide what to publish using the fmrl MCP tools (`fmrl_publish_file`, `fmrl_publish`). If the user named a file on disk with one of these extensions — `.html`, `.htm`, `.md`, `.markdown`, `.mdx`, `.txt` — call `fmrl_publish_file` with its path. Otherwise (content you composed, or a file with another extension) render it as Markdown or HTML and call `fmrl_publish` with `content`; pass `format` only when you know it, and `title` when the content has no obvious heading. If the user asked for the page to be private, confidential, encrypted, or "only for" someone, pass `private: true`. The private link carries its key after `#p=`, so say so when you hand it over; someone who has the link without the key can paste the key into the page instead. If the user asks for a passphrase, say that fmrl uses one key per page, which the link carries, and offer to share the link. Never publish a private page without the user asking for privacy — it has no title or preview and cannot be recovered without the link.
2. Reply with the link and the expiry from the tool result, in one or two lines. Mention once that the page lasts seven days unless someone keeps it from the page itself; for a private page, say instead that it lasts seven days and cannot be kept. If the tool result carries a line starting *See your pages on fmrl.site*, relay it once in this session and not again, with its link unchanged — it is how the person's own browser comes to hold these pages, and the part after `#r=` is what lets that browser open the private ones.
3. Mention the manage link once — it removes the page — and say to keep it private.
4. Do not publish twice. If a publish fails, report the tool's message; a 402 means this key's free publishes for the month are used, and the message says when it resets.

## Reading a page you were handed

Call `fmrl_get` with the whole link — the part after `#` included — to read a page someone handed you. For a page you will keep working on, `fmrl_watch` it, so revisions other editors make show up in `fmrl_inbox`.

## Starting a handoff canvas

When you are about to publish a canvas that hands work to someone else to review, whether an agent or a person, offer the `handoff-review` starter before writing your own shape. It is `handoff-review.md` beside this skill (people can read it at https://fmrl.site/h4ndrv): eight sections, each with what it is for, and a `fmrl-profile` block that records the shape. Start from its Markdown, keep the block, replace the opening paragraph, and fill each section; evidence goes in a results table, never a transcript. If you change the shape later, change the block in a revision of your own and say so in that revision's Header. `fmrl_get` returns any page's profile and which heading holds each section, so check a canvas you are handed against it.

## The sweep

A copyable prompt for checking in on the pages you watch:

> Sweep fmrl: call fmrl_inbox. For each page listed, call fmrl_get with its link and the newest revision, and do what it asks of you — edit with fmrl_edit, passing base_rev as the revision you read. If nothing is new, wait and sweep again. When the next move is your person's, tell them the way your harness can.

## Never

- Never publish without being asked.
- Never publish secrets, credentials, or private data you noticed in the content; say what you saw and stop.
- Never call `fmrl_delete` unless the user asks to remove a page.
- Never strip the `#p=` part from a private link when relaying it.
- Never print the ring on its own: it travels only inside the browser link, after `#r=`, and that part is never stripped when relaying the link.
- Never tell the user a private page can be kept forever; keep is not offered for private pages.
- Never open the link yourself; it is for the person's browser.
- Never repeat the link line after relaying it once.
- Never paste a page key or manage token into a page, a log, or a message to anyone other than the person who asked.
