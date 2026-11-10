<script lang="ts">
  import { Icon } from "@tempra/design/components";
  import { tick, untrack } from "svelte";
  import { useActors } from "../agents.svelte.ts";
  import { post } from "../api";
  import CommentsList from "../comments/CommentsList.svelte";
  import { highlightsOf, placeThreads, type Thread } from "../comments/data";
  import { useDraft } from "../comments/data.svelte.ts";
  import { attachmentSource } from "../images";
  import { here } from "../location.svelte.ts";
  import PageBar from "../PageBar.svelte";
  import Reader from "../Reader.svelte";
  import { type BodyOptions, prepare } from "../reader/prepare";
  import { pushRecent } from "../recent";
  import { useLibraryTitle, useRole } from "../role.svelte.ts";
  import { type Compare, navigate } from "../router";
  import TopbarPath from "../TopbarPath.svelte";
  import { anchorId } from "../ui";
  import { dirOf, folderName, type Urls } from "../urls";
  import Byline from "./Byline.svelte";
  import CheckedLine from "./CheckedLine.svelte";
  import Contents from "./Contents.svelte";
  import { useCompare } from "./compare.svelte.ts";
  import { contentsOf } from "./contents";
  import { bodyHref, type PageData, standing, titleOf } from "./data";
  import { figureViewOf } from "./figures";
  import HoverCard from "./HoverCard.svelte";
  import { type Card, hoverCards } from "./hover";
  import LiveAnnouncer from "./LiveAnnouncer.svelte";
  import LiveChange from "./LiveChange.svelte";
  import type { Live } from "./live";
  import PageFrame from "./PageFrame.svelte";
  import PageInfo from "./PageInfo.svelte";
  import PageTools from "./PageTools.svelte";
  import Panel from "./Panel.svelte";
  import { cornerButton, type PanelName, panelInUrl, threadInHash } from "./panel";
  import RawMarkdown from "./RawMarkdown.svelte";
  import ReviewBar from "./ReviewBar.svelte";
  import type { ReadHistory } from "./reads";
  import SourcesSection from "./SourcesSection.svelte";
  import VersionBar from "./VersionBar.svelte";

  /**
   * A page (take 4, TEMPRA-114; TEMPRA-283; tempra-dev: app/reader, app/comments,
   * decisions/page-tools-in-the-corner): its path in the top bar, its tools in its top-right
   * corner (Comments, Page info, Copy page | ⌄; under the byline where there is no column), the
   * title, description and byline, the body in the reader and its sources at the end, centred in
   * its column; on the right the contents, or one panel in their place (Comments, Page info),
   * opened only by the person and never remembered. Review mode and a version chosen
   * in History draw their diff in the text under a slim bar; View Markdown shows the stored file
   * in place of the page.
   */
  let props: {
    urls: Urls;
    data: PageData;
    head: number;
    compare: Compare | null;
    /** Null while they load, or when they failed (`threadsError`). */
    threads: Thread[] | null;
    threadsError: string | null;
    /** What the last action did (verified, restored). */
    notice: string | undefined;
    /** Someone else's change since this version, if any. */
    live: Live | null;
    onCommented(): void;
    onVerified(): void;
  } = $props();

  const urls = $derived(props.urls);
  const c = $derived(props.data.file);
  const sources = $derived(props.data.sources);
  const links = $derived(props.data.links);
  const actors = useActors(() => props.urls);
  const name = actors.view;
  const role = useRole(() => props.urls);
  const fm = $derived(c.frontmatter);
  const title = $derived(titleOf(c));
  useLibraryTitle(
    () => urls,
    () => title,
  );
  const status = $derived(typeof fm.status === "string" ? fm.status : null);
  const current = $derived(urls.at === undefined || urls.at >= props.head);
  // The Markdown view is in the URL (`?view=markdown`), so back and a shared link keep it.
  const markdown = $derived(here.url.searchParams.get("view") === "markdown");
  function setMarkdown(on: boolean) {
    const to = new URL(location.href);
    if (on) to.searchParams.set("view", "markdown");
    else to.searchParams.delete("view");
    navigate(`${to.pathname}${to.search}${to.hash}`);
  }
  let inlineContents: HTMLDetailsElement | undefined = $state();

  // Footnote markers are numbers: the sources in their order, then the body's other footnotes
  // as they are met (`numbers` fills in as the body is prepared, afresh for each body; the
  // sources section reads it).
  const body = $derived.by(() => {
    const ids = sources.sources.map((s) => s.id).filter((id) => typeof id === "string");
    const numbers = new Map<string, number>(ids.map((id, i) => [id, i + 1]));
    const sourceIds = new Set(ids);
    const broken = new Set(links.broken.map((b) => b.path));
    const images = c.images;
    const options: BodyOptions = {
      path: c.path,
      href: bodyHref(urls),
      image: (path) => {
        const ref = images?.[path];
        return ref ? attachmentSource(urls, ref, path) : null;
      },
      exists: (path) => !broken.has(path),
      // A chart's data file, as the file's own route answers it (TEMPRA-207).
      fileText: async (path) => {
        const res = await fetch(
          urls.api(`files/${path.split("/").map(encodeURIComponent).join("/")}`),
          {
            credentials: "same-origin",
          },
        ).catch(() => null);
        return res?.ok ? res.text() : null;
      },
      footnote: (label, defined) => {
        if (!sourceIds.has(label) && !defined) return null;
        if (!numbers.has(label)) numbers.set(label, numbers.size + 1);
        const prefix = sourceIds.has(label) ? "src" : "fn";
        return { href: `#${anchorId(prefix, label)}`, mark: String(numbers.get(label)) };
      },
    };
    return { prepared: prepare(c.doc, options), numbers };
  });
  const prepared = $derived(body.prepared);
  // A leading heading that repeats the title is not shown twice (the stored body is unchanged).
  const hideFirst = $derived.by(() => {
    const first = prepared.headings[0];
    return first?.first === true && first.text.trim().toLowerCase() === title.trim().toLowerCase();
  });
  const contents = $derived(contentsOf(prepared, hideFirst));
  // The headings' ids: a #fragment naming one goes to the heading, never to a panel.
  const bodyIds = $derived(new Set(prepared.anchors.values()));
  // Link targets' cards, loaded once per path while the page is open.
  const targets = new Map();
  const hover = $derived(hoverCards(urls, sources, prepared, targets));
  const figureView = $derived(figureViewOf(urls, title, name));

  // Review and history: the text against the last verification, or a chosen version.
  const s = $derived(standing(props.data.history, c.seq));
  // A version from History draws what it changed on that version (`?at=…&since=…`); review mode
  // is of the latest only.
  const compare = $derived(current || props.compare?.kind === "since" ? props.compare : null);
  const base = $derived(
    compare?.kind === "since"
      ? compare.seq
      : compare?.kind === "review" && s.verified && s.since > 0
        ? s.verified.event.seq
        : null,
  );
  const changes = useCompare(
    () => urls,
    () => c.path,
    () => prepared,
    () => base,
  );

  // The right column: the contents, or one panel. A page opens on its contents; a panel opens
  // only from a control, a quote, or a link asking for one (`?panel=`, `#thread-…`,
  // `#comments`), and closing it (×, Escape, the control again) brings the contents back.
  let panel = $state<PanelName | null>(untrack(() => panelInUrl(bodyIds)));
  let opener: HTMLElement | null = null;
  let panelBox: HTMLDivElement | undefined = $state();
  // Focus (C-25, TEMPRA-133): opening a panel moves the focus to its heading (a draft's text box
  // takes it instead), and closing it gives the focus back to the control that opened it (its
  // button in the corner row), unless the person has moved on. Both wait for the panel to draw (and
  // for the page to be taken out of inert, where the panel overlays it).
  function focusAfterDraw(to: "heading" | "opener") {
    void tick().then(() => {
      if (to === "heading") {
        panelBox?.querySelector<HTMLElement>(".panel-head h2")?.focus();
      } else {
        const back =
          opener?.isConnected && opener.getClientRects().length > 0
            ? opener
            : cornerButton(closing);
        back?.focus();
      }
    });
  }
  // The panel that last closed: whose corner button takes the focus back.
  let closing: PanelName = "comments";
  function openPanel(which: PanelName, focus = true) {
    const focused = document.activeElement;
    if (
      focused instanceof HTMLElement &&
      !panelBox?.querySelector(".page-aside")?.contains(focused)
    ) {
      // Nothing focused (a quote clicked, text selected): the panel's corner button stands in.
      opener = focused === document.body ? null : focused;
    }
    panel = which;
    if (focus) focusAfterDraw("heading");
  }
  function closePanel() {
    const focused = document.activeElement;
    const lost = !focused || focused === document.body || panelBox?.contains(focused);
    if (panel) closing = panel;
    panel = null;
    if (lost) focusAfterDraw("opener");
  }
  function togglePanel(which: PanelName) {
    if (panel === which) closePanel();
    else openPanel(which);
  }

  // Comments: each thread's quote found in the body on screen, highlighted while open, listed in
  // the Comments panel.
  let active = $state<string | null>(untrack(() => threadInHash(bodyIds)));
  const placed = $derived(placeThreads(props.threads ?? [], prepared.text));
  const openCount = $derived(placed.filter((t) => t.status === "open").length);
  const draft = useDraft(() => prepared.text);
  function startDraft(range: { from: number; to: number }) {
    draft.start(range);
    openPanel("comments", false);
  }
  function onMark(id: string | null) {
    active = id;
    if (id) openPanel("comments");
  }
  const highlights = $derived(highlightsOf(placed, active, draft.draft));
  // A link that asks for a panel or a thread (the Inbox, the home, `?panel=`) opens it when the
  // URL changes to it, and again when the #fragment changes; never on its own otherwise.
  const asked = $derived(panelInUrl(bodyIds, here.url));
  const where = $derived(`${here.url.search}${here.url.hash}`);
  $effect(() => {
    const a = asked;
    void where;
    if (!a) return;
    untrack(() => {
      const id = threadInHash(bodyIds);
      if (id) active = id;
      panel = a;
    });
  });
  $effect(() => {
    const ids = bodyIds;
    const follow = () => {
      const id = threadInHash(ids);
      if (id) active = id;
      if (id || panelInUrl(ids, { search: "", hash: location.hash })) panel = "comments";
    };
    window.addEventListener("hashchange", follow);
    return () => window.removeEventListener("hashchange", follow);
  });
  // Escape closes the panel (one Escape, one thing closed: a menu, a dialog, a draft or the
  // drawer handle theirs first and mark it handled).
  $effect(() => {
    if (!panel) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target instanceof Element ? e.target : null;
      if (e.key === "Escape" && !e.defaultPrevented && !t?.closest("dialog, .menu, form")) {
        e.preventDefault();
        closePanel();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  });

  // Read history (TEMPRA-220, tempra-dev: v2/read-history): the page counts one read each time a
  // person opens it, from here, so prefetches, the boot data and background re-checks (GETs the
  // server never counts for a session) do not. It follows the read's URL, a string, so a redraw
  // or a new version of the same page does not count again; the answer has this read in it.
  const readUrl = $derived(urls.api(`read/${c.path.split("/").map(encodeURIComponent).join("/")}`));
  let readsNow = $state.raw<{ url: string; reads: ReadHistory } | null>(null);
  $effect(() => {
    const url = readUrl;
    let gone = false;
    post<{ reads: ReadHistory }>(url)
      .then((r) => {
        if (!gone) readsNow = { url, reads: r.reads };
      })
      .catch(() => {
        // Not counted (offline, over a limit): the page shows what it loaded.
      });
    return () => {
      gone = true;
    };
  });
  const reads = $derived(readsNow?.url === readUrl ? readsNow.reads : (props.data.reads ?? null));

  // Recent files, for the quick switcher.
  $effect(() => {
    if (urls.at === undefined) pushRecent(urls, { path: c.path, title });
  });

  const live = $derived(props.live);
  const moved = $derived(live && (live.change.op === "move" || live.change.op === "delete"));
  const folders = $derived.by(() => {
    const dir = dirOf(c.path);
    return dir ? dir.split("/").map((_, i, all) => all.slice(0, i + 1).join("/")) : [];
  });
  const mayVerify = $derived(role.current !== null && role.current !== "read");
  const hasContents = $derived(contents.length >= 2);
</script>

{#snippet hoverCard(card: Card)}<HoverCard {card} />{/snippet}
<!-- The page's path over it (TEMPRA-145). -->
{#snippet path()}<TopbarPath path={c.path} {title} />{/snippet}
{#snippet bar()}<PageBar {path} />{/snippet}
{#snippet tools(place: "side" | "head")}<PageTools
    {urls}
    path={c.path}
    {openCount}
    {panel}
    newer={live !== null && !moved}
    {markdown}
    onPanel={togglePanel}
    onMarkdown={setMarkdown}
    {place}
  />{/snippet}
<PageFrame open={panel !== null} classes={markdown ? "markdown-on" : ""} onScrim={closePanel} before={bar} bind:sideBox={panelBox}
  >{#snippet text()}{#if compare}<ReviewBar
          {urls}
          page={c}
          {compare}
          standing={s}
          {name}
          {mayVerify}
          error={changes.error}
          onVerified={props.onVerified}
        />{/if}{#if props.notice}<div class="notice">{props.notice}</div>{/if}{#if moved && live}<LiveChange
          {urls}
          {live}
          notice
        />{/if}<LiveAnnouncer {urls} {live} />{#if !compare && !current}<VersionBar
          {urls}
          page={c}
          standing={s}
          {name}
        />{/if}{#if markdown}<RawMarkdown {urls} path={c.path} hash={c.hash} onBack={() => setMarkdown(false)} />{/if}<!-- Kept mounted under the markdown, so comments keep their place. --><div
        class="doc-page"
        hidden={markdown}
        ><header class="doc-head"
          ><!-- On a phone, whose bar has no room for the path: the page's folders above its title
               (TEMPRA-139, TEMPRA-145). --><nav class="doc-crumbs" aria-label="Folders"
            >{#each folders as f, i (f)}<span>{#if i > 0}<span aria-hidden="true">{" / "}</span>{/if}{folderName(f)}</span>{/each}</nav
          ><!-- Who wrote it and when, above the title, as a blog post's byline (a trial). --><Byline
            page={c}
            history={props.data.history}
            {name}
            {live}
            {current}
            {status}
          /><h1 class="doc-title">{title}</h1
          >{#if typeof fm.description === "string"}<p class="doc-tagline">{fm.description}</p>{/if}{#if current}<CheckedLine {urls} path={c.path} standing={s} {name} />{/if}{@render tools("head")}{#if hasContents}<details
              class="toc-inline"
              bind:this={inlineContents}
              ><summary>On this page<Icon name="down" /></summary><Contents
                headings={contents}
                onPick={() => {
                  if (inlineContents) inlineContents.open = false;
                }}
              /></details
            >{/if}</header
        ><Reader
          {prepared}
          diff={changes.diff}
          {hideFirst}
          {hover}
          card={hoverCard}
          {highlights}
          {onMark}
          onComment={current ? startDraft : undefined}
          {figureView}
        /><SourcesSection {urls} data={sources} {prepared} numbers={body.numbers} /></div
      >{/snippet}{#snippet side()}{@render tools("side")}{#if panel === "comments"}<Panel name="comments" count={openCount > 0 ? `${openCount} open` : null} onClose={closePanel}
          ><CommentsList
            {urls}
            path={c.path}
            {placed}
            error={props.threadsError}
            loading={props.threads === null && props.threadsError === null}
            writable={current}
            draft={draft.draft}
            onDraftDone={draft.clear}
            {active}
            onActive={(id) => (active = id)}
            onChanged={props.onCommented}
          /></Panel
        >{:else if panel === "info"}<Panel name="info" onClose={closePanel}
          ><PageInfo
            {urls}
            page={c}
            {links}
            head={props.head}
            standing={s}
            {reads}
            {name}
            {current}
            reviewing={compare?.kind === "review"}
            comparing={compare?.kind === "since"}
            {mayVerify}
            live={live && !moved ? live : null}
            onVerified={props.onVerified}
          /></Panel
        >{:else if hasContents && !markdown}<nav class="page-contents" aria-label="Contents"
          ><Contents headings={contents} /></nav
        >{/if}{/snippet}</PageFrame
>
