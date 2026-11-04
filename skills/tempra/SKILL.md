---
name: tempra
description: Read and maintain a Tempra library (folders of markdown pages kept by people and agents) through the Tempra MCP server. Use when the Tempra MCP tools (start, browse, read, write, edit, …) are connected, or when asked to look something up in, add to, or clean up the team's knowledge base.
---

# Working in a Tempra library

## What a library is

- A library is a tree of folders of markdown **pages**, each starting with YAML frontmatter, plus attachments (images, video, audio, PDFs, data files).
- A page's frontmatter holds its `title` and a one-line `description`, and whatever else the page needs: `tags`, `sources`, `status`, `stale_after`, `resource` (the URI of what the page describes), a `type` naming what kind of page it is where the library has several of a kind (Decision, Dataset), or fields of your own.
- A library may say how it likes to be written in a `guide.md` at its root. Read it first when there is one, and follow it.
- Pages link to each other with ordinary markdown links. Absolute links (`/tables/orders.md`) are preferred.
- `sources` lists what a page was derived from: each entry is `id`, `title` and `resource` (a URL, or a path in this library); `url` is taken as `resource`. Individual claims cite a source with a footnote whose label is a `sources[].id`: `…is sharded daily.[^ga4-schema]`. A `resource` inside the library (`/policies/margin-standard.md`) is tracked like a link: it follows moves and is flagged when missing.
- Trust: `generated` records who wrote the current content (stamped by the server). `verified` records who checked it (a human or a process, never you). The trust tier is derived from these: unverified, machine-confirmed, or human-reviewed.
- Lifecycle: `status` is optional: `draft` while a page is unfinished, `deprecated` once it is retired, and `stable` (what an absent status reads as) otherwise. It is the page's maturity, not a review: only people check pages. `stale_after` is the instant the content should be re-checked, a full datetime with an offset (`2026-12-31T00:00:00Z`), not a plain date; set it only when something the page relies on will change.
- `index.md` (directory listings) and `log.md` (history: the latest 200 requests, then a pointer to `log` with `before` for older ones) are synthesized by the server. Never write them. An index is only as good as the titles and descriptions of the pages in its directory: `work` items of kind `structure` point at what makes one poor (descriptions missing, over 200 characters or repeating the title, titles that read the same, over 50 pages in one directory). How the library is laid out, how many pages a folder holds and what links where are the library's own choice.

Every write is attributed to your token's actor and recorded in a ledger. Nothing is lost: any change can be diffed and reverted.

## Reading: progressive disclosure

1. `start` once per session: the root index, counts, open work, the daily health check (open work by kind, the newest changes nobody has verified), and house rules. If your connection reaches several libraries, `start` lists them; open one with `start` and `library` (`owner/slug`), then pass the same `library` on every call.
   - When the person asks for a new library, `create_library` (`slug`, optional one-line `title` and `description`) makes one they own, exactly as if they made it in the app, and opens it as `start` does. It works only on a read-and-write app connection the person allowed to create libraries at consent, and counts against their library limit. Inviting people, sharing, transferring and deleting stay with the person, in the app.
2. `browse` a directory to see its pages' titles and descriptions before opening any.
3. `read` the page you need. Look at the header first: trust tier, `stale`, `status`, lint, inbound links, and its figures (one line each, numbered as the app numbers them). Then read the frontmatter, then the body. To see the figures themselves, see [Figures and media](#figures-and-media).
4. Follow links to related pages rather than guessing paths. Use `search` (ranked) or `grep` (exact text) when you do not know where something is.

Treat a `stale`, `deprecated` or unverified page as a lead to confirm, not a fact.

## Writing a page

```markdown
---
title: Gross Margin
description: Gross margin for a period, per the FY2026 cost allocation standard.
tags: [finance, margin]
stale_after: 2026-12-31T00:00:00Z
sources:
  - id: margin-standard
    resource: /policies/margin-standard.md
    title: Cost Allocation & Margin Standard (FY2026)
---

# Definition

Gross margin equals recognized [revenue](/metrics/revenue.md) minus full COGS.[^margin-standard]

[^margin-standard]: Cost Allocation & Margin Standard (FY2026)
```

- A `title`, and a `description` of one sentence: it is what `browse`, indexes and search show.
- Shape folders and pages to the content. A long page is fine when it reads as one; split it when a reader would want part of it on its own.
- Absolute links (`/dir/file.md`). A link to a page that does not exist yet is allowed; it shows up in `work` as a broken link until someone writes it. Links, `sources` resources in the library and footnotes are checked on every write and again daily, so a page broken by someone else's move or delete shows in `work` too.
- Every footnote label matches a `sources[].id`, and every `[^id]` in the text has a `[^id]: …` definition line at the end of the body (without one, renderers show it as literal text).
- Images and diagrams: see [Figures and media](#figures-and-media).
- Timestamps (`stale_after`, `sources[].last_modified`) are ISO 8601 datetimes with an offset (`2026-06-30T14:00:00Z`). A plain date such as `2026-12-31` is flagged.
- Only a new `stale_after` resets a page's clock: an edit that leaves it alone leaves the page stale (or stale soon, within 14 days of it). Move it forward when you have re-checked the content, not because you touched the file.
- Do not write `generated` or `verified`. The server ignores them and says so in the write result's notes.
- A file with no frontmatter, or frontmatter that is not valid YAML, is refused (400) and nothing is written; fix it and write again. The rest is lint: no `description`, an unknown `status`, a footnote with no source or definition, a Mermaid fence that is plainly broken, and a link to a heading its target does not have (rechecked whenever you read, so it follows changes to the target). A `stale_after` already past comes back as a note.

## Editing

- `edit` for small changes: find-and-replace on the document as `read` shows it, frontmatter included. Each `old` must match once; quote enough context.
- Bodies are stored in a canonical form: `-` bullets, `*` emphasis, ATX headings, fenced code, padded tables; in the frontmatter, a list of mappings such as `sources` one key per line, and a list of scalars such as `tags` on one line (`[a, b]`). What you write reads back normalized, and is byte-stable after that; when it differs from what you sent, the write result says so and shows the diff. Quote `old` from what `read` shows, not from what you sent.
- `write` for a new page or a full rewrite. Replacing needs `if_match`.
- `batch` for related changes (a new page plus the links to it; a rename plus fixes) so they land as one request.
- `attach` and `prepare_upload` store a non-markdown file: see [Figures and media](#figures-and-media).
- `move` renames a file or a whole directory. Links keep working; do not fix them by hand.
- Put a one-line `note` on every write, saying why. Humans read the ledger.
- Read the `lint` in every write result and fix it in the same session. The result's notes say what else to know: ignored fields, the stored form, the page's open comment threads and any your edit left outdated, and after a delete, the pages whose links it broke.

## Figures and media

**When a figure helps.** A screenshot of what the page describes; a chart of data the page discusses; a diagram of an architecture or a flow. Leave out pictures that only decorate.

**Two kinds of media.** *Rendered media* is code in the page that the app draws: a chart as a Vega-Lite spec, a Mermaid diagram, or a drawing in an `svg` fence. *Files* are images (PNG, JPEG, GIF, WebP, AVIF, SVG), video, audio and PDF, stored beside the page. For a chart or a flow, prefer rendered media to a picture: it is a few hundred tokens of text, diffs like text, and needs no upload.

**Diagrams** are Mermaid in a `mermaid` fence. Before writing a non-trivial one, preview it with `render` (`source`: the fence's body or the whole fence, its language told from the source or given as `lang`; or `path` and `figure` for one already written): it returns the drawing as an image, or Pele's error with line and column, writes nothing, and allows 60 renders a minute per account. On a write, `diagram_invalid` lint (an unknown type, nothing after the header, a bracket or quote left open) and `diagram_unrendered` lint (Pele, the renderer, could not draw it; in the write result, or only in `work` and the next `read`) both mean: fix the fence. Either is saved anyway, and the app shows its source. Lint on any fence (Mermaid, SVG or chart) names it as `read`'s Figures list numbers it ("Figure 4 (mermaid, `flowchart LR`, block b7)"), the number `render` and `read` take with `figure` and `figures`.

**Charts** are Vega-Lite specs (JSON, Vega-Lite 6) in a `vega-lite` fence: `` ```vega-lite alt="what it shows" title="Caption" ``. Write a chart this way rather than making a picture of one: it is drawn in the reader's greys in light and dark, diffs like text and needs no upload. Its data is inline (`"data": {"values": [...]}`, or CSV text with `"format": {"type": "csv"}`) or a CSV, TSV or JSON file in this library named by `data.url` (`"data": {"url": "/data/sales.csv"}`, put beside the page with `attach` or `prepare_upload`); nothing else is fetched. `chart_invalid` lint means it is not JSON, names data from elsewhere, does not fit Vega-Lite's schema (in the write result, at its path in the spec: `encoding.x.type: "bogus" is not one of "quantitative", …`), or Vega could not draw it (with Vega's message, from after the write); no `alt="…"` and no `description` in the spec is `image_no_alt`. `render` previews one before you write it, with what the write would report (`chart_invalid`, and `image_no_alt` when you pass the whole fence).

**SVG fences** are drawings written as SVG in an `svg` fence: `` ```svg alt="what it shows" title="Caption" ``. Use plain shapes and text, and `currentColor` for ink, which follows the reader's light and dark themes; up to 50 KB. The app draws it sanitized: scripts, event handlers, `<style>` elements (use attributes), images, links, animation and references outside the SVG are taken out and named as `svg_unsafe` lint; one that does not parse is `svg_invalid` lint with its line and column; no `alt="…"` and no `<title>` is `image_no_alt`. `render` previews one before you write it, with what the write would report (`svg_unsafe` naming what it takes out, `svg_invalid`, and `image_no_alt` when you pass the whole fence).

**Adding a file.** A file comes in only two ways, and never as bytes you type into a call:

- **On the public web:** `attach` with `source_url`. The server fetches it (https only, no credentials in the URL, at most 3 redirects, 10 s, up to 10 MB; images, video, audio and PDF, judged by the bytes; a refusal is `fetch_refused` naming the rule) and records the URL and fetch time as the file's source. That is not a citation: cite the original in the page's `sources` too. Never hotlink.
- **Not on the web:** `prepare_upload` (up to 10 MB). It returns a `curl -T <file> '<url>'` line (one PUT within an hour) and an upload link for the person; in a chat that shows apps, an upload panel appears with the call. Then, by where the file is:
  - Your shell reaches the server: run the curl line. curl prints the write result.
  - The person has it (a photo they attached in the chat: you cannot pass on a chat's attachment): ask them to choose it in the upload panel, and give them the upload link in case the panel does not show.
  - You made it where you cannot reach the server (curl fails to connect, or a proxy refuses it, as in a chat's sandbox): give the file to the person in the chat, call `prepare_upload` with `origin: "agent"`, and tell them in a sentence or two why they are asked: you cannot send files to Tempra yourself, so they upload the one you gave them. The panel and the link say the same.

  From their browser it is attached as your write, with your note, description, credit and licence, recorded as supplied by them; `read` the path to see when it has arrived. Whatever file arrives is the file; a transfer cut short is refused (`incomplete_upload`).

Images (PNG, JPEG, GIF, WebP, AVIF, SVG) are checked on write: a broken one is refused with `bad_image`, and the type comes from the bytes. Give an attachment a one-line `description` (up to 500 characters), and give it its `credit` and `licence` (up to 200 characters each); the file's page shows them. A file the person gave you or you made carries its own `credit` and `licence` and needs no `sources` entry: say who supplied it (`Photo supplied by @ann`) and the licence if known.

**Changing a stored file.** You cannot fetch an attachment to change it, so `transform` does it on the server: `resize` to a long `edge` (never enlarged; the fix for `image_large`), `crop` to a `box`, `convert` to WebP, PNG or JPEG, a `thumbnail`, or a video's `poster` (its frame at `time` seconds, written as `x.poster.png` beside the video, which the reader shows before it plays; WebM only for now, as the server cannot decode MP4's H.264). Resize and crop replace the image in place with `if_match`, or write to `to`; the others write beside it. The result is your write, recorded as made from the original; its description, credit and licence carry over.

**Where it lives.** Beside the page that uses it, named for what it shows: `dir/x.md` uses `dir/x-architecture.png`. Link it by absolute path.

**How to write it.** `![what it shows](/dir/x-architecture.png "Caption")`: the alt says what the image shows (what a screen reader says, and what an agent reads when it does not ask for the image); the title is the caption. For a width, a placement or a group, wrap one to four images, one to a line, in a `:::figure` block:

```markdown
:::figure[The top bar before and after]{width=480 layout=wide frame}
![The top bar with crumbs](/app/bar-before.png "Before")
![The top bar with the path](/app/bar-after.png "After")
:::
```

`width` is pixels or a share of the column (`60%`), never wider than the image; `layout` is `column` (the default), `wide` or `full`; `frame` draws a hairline round screenshots. In a group the `[…]` label is the caption and each title a small label. Video, audio and PDF use the image spelling (`![A walkthrough](/dir/x-demo.mp4 "Caption")`), with a video's poster attached beside it as `x-demo.poster.png`. Cite a work taken from elsewhere (a web image) in `sources`, with its footnote right after the image (`![A ridge at dusk](/dir/x-ridge.jpg "Caption")[^ridge]`; it is still a figure, and the marker ends its caption); a file the person gave you or you made carries its own `credit` and `licence` instead.

**Lint**, never a refusal, and in `work` until fixed: `image_no_alt` (say what it shows), `image_external` (hotlinked: `attach` it with `source_url`, point the image at the attached path, cite the original; `work` lists them as one `external_image` item per page), `image_large` (over 2 MB or 4000 px on its long edge; attach a smaller one), `image_not_image` (`![…](x)` on a file that is not an image, video, audio or PDF; link it instead), `figure_invalid` (the markup does not parse; its images show plainly).

**Seeing it.** `read` lists a page's figures in its header (path or URL, alt, caption, dimensions, size, and `ok`, `missing` or `external`; diagrams by type). Before changing a figure or its caption, or answering a comment on one, `read` with `images: true` to see the images, `diagrams: true` to see the diagrams drawn as people see them, or `figures: [n]` for some of either: at most 6 and 2 MB a call, the rest listed with the reason; external images are not fetched. `read` on an image attachment returns it scaled for you (an SVG as its text; `image: false` for its facts only); a PDF up to 2 MB comes as an embedded resource; video and audio are facts only.

## Conflicts

Pass `if_match` with the hash from your last `read`. If another agent changed the file since, you get a 412 with the current hash. Re-read, reapply your change to the new content, and write again. Do not overwrite blindly. Writing without `if_match` to a path that exists is a 409 `exists`: pass its hash to replace it, or pick another path. In a `batch`, an error says which op failed (`Op 2 of 3`).

## Beyond files

These tools have no equivalent in a folder of files. Use them instead of grepping YAML or guessing:

| Need | Tool |
| --- | --- |
| What others changed recently | `log` |
| What needs fixing (open comments, requests, stale, broken links, lint, hotlinked images, structure); what goes stale within 14 days (`kind: stale_soon`) | `work` |
| Requests and questions people left on a page or on the library | `comments`, then `comment` |
| Find by meaning, ranked | `search` |
| Filter by tag, status, trust, staleness, reads | `query` |
| What links here, and what this links to | `links` |
| Which sources back which claims | `sources` |
| A page's past versions | `history`, `read(path, at)`, `diff` |
| See a diagram, SVG or chart drawn, before or after writing it | `render` |
| Undo a change or a whole request (the library's owner only) | `revert` |
| The whole library as files (each diagram drawn beside its page as `<page>.diagrams/<n>.svg`, which import ignores); `format: "okf"` for a bundle that conforms to Google's Open Knowledge Format | `export` |

A good maintenance session: `start`, `log` to see what changed, `work` to pick an item, fix it, repeat.

## Comments

Comments are how people ask you for changes. A thread sits on a page, often on a quoted sentence, or on the library itself (no path; people start those from the library's home), and stays open until someone resolves it. Comments are not content: they never change the page or its hash, `log.md` and exported bundles leave them out, and the ledger (`history`, the nightly backup) keeps them.

- `read` says when a page has open comments. Read them with `comments` (pass `path`) before you edit it.
- Make the change the thread asks for with the normal write tools, then `comment` with `reply` saying what you did, and `resolve` (a resolve can carry that closing reply).
- Unsure what is meant? `reply` with a question and leave the thread open. If the last reply is yours, wait for an answer.
- Resolve only what you addressed. `reopen` a thread you resolved by mistake.
- You can start a thread too (`comment` with `open`, a `path` and optionally a `quote` copied from the body as `read` shows it; it is matched by the text it reads as, markup aside; with no `path`, on the library itself), to ask a person something you cannot decide. Write `@handle` in a comment to address a person who can reach the library: it lands in their inbox (and their mail, if they have it on); `comments` shows who each comment mentioned. `comments` with an empty `path` lists the library's own threads.
- A **request** is a thread marked as a bigger ask (a new page, a restructure, research) for people's agents: `work` lists it as a `request` item, and `comments` says `request`. Do the work it asks for, `reply` with what you did, and resolve it. Mark a thread a request yourself with `kind: "request"` on `comment` `open` or `reply` (and `kind: "comment"` to unmark it). Tempra's own agent, @tempra, answers people in threads when they mention it, makes only small edits, and files bigger asks as requests; it never resolves a request.
- An outdated thread's quote is gone from the body; it may already be fixed. Check, then answer it.
- A page with open threads cannot be deleted (409 `open_comments`): answer and resolve them first.

## Showing a page to the person

`show` draws one page for the person, as the Tempra app draws it, in a panel in the chat (in a chat that shows apps; elsewhere give them the link it returns). Use it when they ask to see a page, or when you want them to read one, such as one you just wrote. It is for reading only. Do not `show` pages you only read for yourself.

When you tell the person about a page, link it by its URL in the app, never its bare path: `read` gives a page's `url`, a write's result names each written page's (and the library's Activity), `search` gives one per result, and `start` gives the library's URL (a page opens at its path after it).

## When to split a page

Split a page when a reader would want part of it on its own, when it mixes things people look up separately (a definition and a procedure), or when it approaches the 100 KB cap (the server refuses larger ones). Link the parts from the page that held them.

## Etiquette with other agents and humans

- Read before you write, and pass `if_match`.
- One-line `note` on every write.
- `edit` for small changes, `batch` for related ones.
- Never write `index.md` or `log.md`. Never claim verification.
- Answer the comments on what you change; never resolve one you did not address.

## Connecting

The server speaks MCP over Streamable HTTP at `https://tempra.dev/mcp`. An app connection reaches the libraries its approver chose (all of the account's, or a selection); a bearer token reaches one library.

- **claude.ai, ChatGPT and other apps:** add the URL as a custom connector and approve it in the browser (OAuth; the approver picks all libraries or selected ones, read or write access, whether you may create libraries for them, and the name your changes carry). A connection to selected libraries also reaches the libraries it creates, and nothing else.
- **Claude Code and scripts:** use a bearer token, minted by a human on the service's Agents page (New token, `https://tempra.dev/agents`):

```sh
claude mcp add --transport http tempra https://tempra.dev/mcp \
  --header "Authorization: Bearer <token>"
```

With a bearer token, use two libraries by adding two connections.
