<script lang="ts">
  import { tick, untrack } from "svelte";
  import { whoWorksHere } from "../activity";
  import { useActors } from "../agents.svelte.ts";
  import CommentsList from "../comments/CommentsList.svelte";
  import { LIBRARY_THREADS, type Placed } from "../comments/data";
  import { useThreads } from "../comments/data.svelte.ts";
  import { useFrame } from "../frame.svelte.ts";
  import { useFeed, useTrailing } from "../live.svelte.ts";
  import { useLoad } from "../load.svelte.ts";
  import { here } from "../location.svelte.ts";
  import { useMentionable } from "../mentions.svelte.ts";
  import PageFrame from "../page/PageFrame.svelte";
  import PageTools from "../page/PageTools.svelte";
  import Panel from "../page/Panel.svelte";
  import { cornerButton, panelInUrl, threadInHash } from "../page/panel";
  import { libraryLabel } from "../role";
  import { useLibrary, useRole } from "../role.svelte.ts";
  import Status from "../Status.svelte";
  import { plural } from "../ui";
  import { useMe, useTitle } from "../ui.svelte.ts";
  import type { Urls } from "../urls";
  import EmptyLibrary from "./EmptyLibrary.svelte";
  import { homeKey, loadHome, recentlyChanged } from "./home";
  import RecentlyChanged from "./RecentlyChanged.svelte";

  /**
   * The library's home (take 4, TEMPRA-117, TEMPRA-121; tempra-dev: app/home): its title and
   * description, one quiet line (who works here, the page count, the guide), and the pages changed
   * most recently. No sections: the tree beside it lists the folders (TEMPRA-138); no housekeeping,
   * which is the agents' (TEMPRA-144); no notifications, which are the Inbox's, and no "since you
   * last looked", which is Activity's to show when asked (TEMPRA-173). An empty library shows how to
   * connect an agent instead (to those who can). Each part loads on its own, so one that fails
   * leaves the rest (H-7). It is laid out as a page is (TEMPRA-283, TEMPRA-294, `PageFrame`): the text in its
   * column and the side column on the right, whose corner row holds Comments alone (a default the
   * owner may change), the library's own threads (TEMPRA-222); its panel floats there as a page's
   * does, overlays the page under 960px of page and is the sheet on a phone, and the row moves
   * under the head where the column is gone.
   */
  let { urls }: { urls: Urls } = $props();

  const library = useLibrary(() => urls);
  const lib = $derived(library.current);
  const name = $derived(libraryLabel(lib ?? urls));
  useTitle(() => name);
  const me = useMe();
  const role = useRole(() => urls);
  const actors = useActors(() => urls);
  const frame = useFrame();
  const loaded = useLoad(
    () => homeKey(urls),
    () => loadHome(urls),
  );
  // Who works here (the owner and members; none until they load, as the owner is always one):
  // only the header's quiet line needs it, so a failure drops only that line.
  const members = useMentionable(() => urls);
  const reload = useTrailing(() => loaded.reload(), 1500);
  // The library's own threads (TEMPRA-222), reloaded when the feed carries a comment on them.
  const threads = useThreads(
    () => urls,
    () => LIBRARY_THREADS,
  );
  useFeed(
    () => urls,
    () => loaded.data?.head ?? null,
    (events) => {
      reload();
      if (events.some((e) => e.op === "comment" && e.path === "")) threads.reload();
    },
    () => {
      reload();
      threads.reload();
    },
  );
  const placed = $derived<Placed[]>((threads.data?.threads ?? []).map((t) => ({ ...t, at: null })));
  const openCount = $derived(placed.filter((t) => t.status === "open").length);

  // The Comments panel: opened by the person (Comments, a link to a thread, `?panel=comments`),
  // never by itself; where it overlays the page it is modal (PageFrame's call).
  let panel = $state<boolean>(untrack(() => panelInUrl() === "comments"));
  let active = $state<string | null>(untrack(() => threadInHash()));
  let panelBox: HTMLDivElement | undefined = $state();
  function focusAfterDraw(to: "heading" | "opener") {
    void tick().then(() => {
      if (to === "heading") panelBox?.querySelector<HTMLElement>(".panel-head h2")?.focus();
      else cornerButton("comments")?.focus();
    });
  }
  function openPanel() {
    panel = true;
    focusAfterDraw("heading");
  }
  function closePanel() {
    const focused = document.activeElement;
    const lost = !focused || focused === document.body || panelBox?.contains(focused);
    panel = false;
    if (lost) focusAfterDraw("opener");
  }
  // A link to a thread or the comments (a notification, `?panel=comments`) opens the panel.
  const where = $derived(`${here.url.search}${here.url.hash}`);
  $effect(() => {
    void where;
    untrack(() => {
      if (panelInUrl() !== "comments") return;
      const id = threadInHash();
      if (id) active = id;
      panel = true;
    });
  });
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

  // The frame's index when it has arrived (it follows the feed), else the summary (`empty`).
  const files = $derived(frame.index);
  const handle = $derived(me.current?.handle ?? null);
  const people = $derived(members.people.length > 0 ? members.people : null);
  const you = $derived(handle !== null && (people?.includes(handle) ?? false));
  const agents = $derived(actors.contributors.filter((c) => c.agent).length);
  const guide = $derived(files?.some((f) => f.path === "guide.md" && f.kind === "page"));
  const who = $derived(
    people === null ? null : whoWorksHere(you, people.length - (you ? 1 : 0), agents),
  );
  const canWrite = $derived(role.current === "owner" || role.current === "write");
</script>

{#snippet tools(place: "side" | "head")}<PageTools
    {urls}
    {openCount}
    panel={panel ? "comments" : null}
    onPanel={() => (panel ? closePanel() : openPanel())}
    {place}
  />{/snippet}
<PageFrame open={panel} onScrim={closePanel} bind:sideBox={panelBox}>
  {#snippet text()}
  <Status loaded={loaded.current}>
    {#snippet children(home)}
      {@const empty = files === null ? home.pages === 0 : files.length === 0}
      {@const meta = [who, plural(home.pages, "page")].filter((p): p is string => p !== null)}
      <header class="view-head home-head">
        <div class="view-head-main">
          <h1 class="view-title">{name}</h1>
          {#if lib?.description}
            <p class="view-lede">{lib.description}</p>
          {/if}
          {#if !empty && (meta.length > 0 || guide)}
            <p class="view-meta home-who">{meta.join(" · ")}{#if guide}{meta.length > 0 ? " · " : ""}<a href={urls.file("guide.md")}>Start with the guide</a>{/if}</p>
          {/if}
          <!-- Where the side column is gone, the corner row sits under the head, as a page's. -->
          {@render tools("head")}
        </div>
      </header>
      {#if empty}
        <EmptyLibrary
          {urls}
          access={role.current}
          latest={home.latest}
          who={home.latest ? actors.view(home.latest.actor, home.latest.by) : null}
        />
      {:else}
        <!-- A first library with only its guide: how to connect an agent. -->
        {#if home.noAgentYet && canWrite}
          <EmptyLibrary
            {urls}
            access={role.current}
            latest={null}
            who={null}
            heading="Connect an agent"
          />
        {/if}
        {#if files !== null}
          <RecentlyChanged
            {urls}
            changed={recentlyChanged(home.requests, files)}
            view={(a, by) => actors.view(a, by)}
          />
        {/if}
      {/if}
    {/snippet}
  </Status>
  {/snippet}
  {#snippet side()}
    {@render tools("side")}
    {#if panel}
      <Panel name="comments" count={openCount > 0 ? `${openCount} open` : null} onClose={closePanel}>
        <CommentsList
          {urls}
          path=""
          {placed}
          error={threads.error?.message ?? null}
          loading={threads.data === undefined && !threads.error}
          writable={role.current !== null}
          draft={null}
          onDraftDone={() => {}}
          {active}
          onActive={(id) => (active = id)}
          onChanged={() => threads.reload()}
        />
      </Panel>
    {/if}
  {/snippet}
</PageFrame>
