---
name: share
description: Share, send, hand off, publish, or "get a link for" something made in this chat — a report, a page, a snippet. Publishes it as a public page on fmrl.site through the fmrl connector and returns the link. Never publishes unless the user asked to share.
---

# Share with fmrl: publish what is at hand and return the link

Use this when the user asks to share, send, hand off, publish, or get a link for something you made or have open. A request to draft, summarize, save, or improve something is not a request to share it: do not publish unless sharing was asked for.

This connector publishes **public** pages only. Anyone with the link can read the page.

## Steps

1. If the user asks for a page they shared earlier, call `fmrl_list` and hand back its link instead of publishing again. Otherwise render the content as Markdown or HTML and call `fmrl_publish` with `content`; pass `format` only when you know it, and `title` when the content has no obvious heading.
2. If the user asked for the page to be private, confidential, encrypted, or "only for" someone, do not publish it. Say that this connector makes public pages only, and that private pages are made from the fmrl site itself or a local fmrl install. Never publish it as a public page instead.
3. Reply with the link and the expiry from the tool result, in one or two lines. Mention once that the page lasts seven days unless someone keeps it from the page itself.
4. Do not publish twice. If a publish fails, report the tool's message; when the free publishes for the month are used, the message says when they reset.

## Reading and editing a page

Call `fmrl_get` with the whole page link to read a page someone handed you. `fmrl_edit` revises a public page this connection published, passing `base_rev` as the revision you read; editing a page also watches it, so revisions other editors make show up in `fmrl_inbox`. `fmrl_watch` is for a page you read and do not edit. `fmrl_whoami` says which fmrl identity this connection publishes as and how many publishes are left this month.

## Composing canvas links

Canvas content runs inside a sandboxed iframe, so choose link targets by destination:

- A table of contents or other same-page link uses a fragment-only link to an existing element ID, with `target="_self"` or no target.
- Links leaving the page use `target="_blank" rel="noopener noreferrer"`, including links to another fmrl page. Use the full page URL the tools give.
- Never use `_top`, `_parent`, or a blanket `<base target="_blank">`.
- Publish self-contained content with inline assets; files beside the content are not uploaded with it.

## The sweep

A copyable prompt for checking in on the pages you watch:

> Sweep fmrl: call fmrl_inbox. For each page listed, call fmrl_get with its link and the newest revision, and do what it asks of you — edit with fmrl_edit, passing base_rev as the revision you read. When the next move is the user's, tell them.

## Never

- Never publish without being asked.
- Never publish secrets, credentials, or private data you noticed in the content; say what you saw and stop.
- Never publish a page the user asked to keep private, and never retry a refused request as a public page.
- Never call `fmrl_delete` unless the user asks to remove a page.
- Never open the link yourself; it is for the user.
