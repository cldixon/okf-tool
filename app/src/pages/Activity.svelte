<script lang="ts">
  import { Icon, Notice, Segmented } from "@tempra/design/components";
  import { activityKey, loadActivity } from "../activity";
  import { useLiveWrites } from "../activity.svelte.ts";
  import { useFeed, useTrailing } from "../live.svelte.ts";
  import { useLoad } from "../load.svelte.ts";
  import PageColumn from "../PageColumn.svelte";
  import { useLibraryTitle } from "../role.svelte.ts";
  import { type Done, navigate } from "../router";
  import Status from "../Status.svelte";
  import { plural } from "../ui";
  import type { ActivityFilters, ActivityView, Urls } from "../urls";
  import EventFilters from "./EventFilters.svelte";
  import EveryEvent from "./EveryEvent.svelte";
  import Older from "./Older.svelte";
  import Summary from "./Summary.svelte";
  import WhoFilter from "./WhoFilter.svelte";

  /**
   * Activity (take 4, TEMPRA-115; tempra-dev: app/activity, decisions/three-activity-surfaces):
   * what happened in the library, in two views under one switch. The Summary (the default) tells
   * each request as a sentence, grouped by day, with an agent writing now as a live entry at the
   * top; Every event is the ledger as a table, with Download. `-/ledger` opens Every event. Both
   * follow the change feed. Nothing is marked "new since you looked" (TEMPRA-173): a person comes
   * here to look, and is not kept count of.
   * The view and filters are in the URL, so a view can be linked and back and forward restore it.
   */
  let {
    urls,
    filters,
    done = null,
  }: { urls: Urls; filters: ActivityFilters; done?: Done } = $props();

  useLibraryTitle(
    () => urls,
    () => "Activity",
  );
  const view = $derived(filters.view === "events" ? "events" : "summary");
  const prefix = $derived(filters.prefix ?? "");
  const exact = $derived(filters.actor ?? "");
  // Switching the view is a move of its own (back returns to the other); filters replace.
  const go = (change: ActivityFilters, replace = true) =>
    navigate(
      view === "events" && change.view === undefined && location.pathname.endsWith("/-/ledger")
        ? urls.ledger({ ...filters, ...change })
        : urls.activity({ ...filters, view, ...change }),
      { replace },
    );
  const key = $derived(activityKey(urls, filters));
  const loaded = useLoad(
    () => key,
    () => loadActivity(urls, filters),
  );

  // Live (tempra-dev: app/live): a write the filters may match reloads the newest page, once per
  // burst (pages' titles come from the frame's index, which follows the feed itself). An agent's
  // write is remembered as writing now (the pulsing dot).
  const reload = useTrailing(() => loaded.reload());
  const live = useLiveWrites();
  useFeed(
    () => urls,
    () => loaded.data?.head ?? null,
    (events) => {
      live.heard(events);
      const under = (p: string | null) =>
        !prefix || p === prefix || !!p?.startsWith(`${prefix.replace(/\/$/, "")}/`);
      const hit = events.some(
        (e) => (!exact || e.actor === exact) && (under(e.path) || under(e.from_path)),
      );
      if (hit) reload();
    },
    () => {
      live.reset();
      reload();
    },
  );
</script>

<PageColumn>
  <header class="view-head">
    <div class="view-head-main">
      <h1 class="view-title">Activity</h1>
    </div>
  </header>
  {#if done?.kind === "revert"}
    <Notice tone="ok">Reverted: {plural(done.n ?? 0, "change")}, recorded as a new change by you.</Notice>
  {/if}
  <div class="view-filters activity-filters">
    <Segmented
      label="View"
      options={[
        { value: "summary", label: "Summary" },
        { value: "events", label: "Every event" },
      ]}
      value={view}
      onchange={(v) => go({ view: v as ActivityView }, false)}
    />
    <WhoFilter
      {urls}
      {view}
      who={filters.who ?? "everyone"}
      actor={exact}
      onChange={(who, a) => go({ who, actor: a || undefined })}
    />
    {#if view === "events"}
      <EventFilters kind={filters.kind ?? ""} q={filters.q ?? ""} onChange={(change) => go(change)} />
      <a class="button activity-download" href={urls.ledgerJsonl()} download><Icon name="download" />Download</a>
    {/if}
  </div>
  <Status loaded={loaded.current}>
    {#snippet children(page)}
      {#key key}
        <Older {urls} {prefix} actor={exact} first={page}>
          {#snippet children(requests, more)}
            {#if view === "summary"}
              <Summary
                {urls}
                {requests}
                empty={page.requests.length === 0}
                who={filters.who ?? "everyone"}
                writing={live.writing}
                now={live.now}
              />
            {:else}
              <EveryEvent
                {urls}
                {requests}
                empty={page.requests.length === 0}
                filter={{ who: filters.who, kind: filters.kind, q: filters.q }}
                {more}
                pulses={live.pulses}
              />
            {/if}
          {/snippet}
        </Older>
      {/key}
    {/snippet}
  </Status>
</PageColumn>
