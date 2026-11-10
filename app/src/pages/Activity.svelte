<script lang="ts">
  import { Notice, PillButton, Segmented } from "@tempra/design/components";
  import { activityKey, inFolder, loadActivity, workingNow } from "../activity";
  import { useLiveWrites } from "../activity.svelte.ts";
  import { useFeed, useTrailing } from "../live.svelte.ts";
  import { useLoad } from "../load.svelte.ts";
  import PageColumn from "../PageColumn.svelte";
  import { useLibraryTitle } from "../role.svelte.ts";
  import { type Done, navigate } from "../router";
  import Status from "../Status.svelte";
  import { plural } from "../ui";
  import type { ActivityFilters, ActivityView, Urls } from "../urls";
  import ByPage from "./ByPage.svelte";
  import EventFilters from "./EventFilters.svelte";
  import EveryEvent from "./EveryEvent.svelte";
  import FolderFilter from "./FolderFilter.svelte";
  import Older from "./Older.svelte";
  import WhoFilter from "./WhoFilter.svelte";

  /**
   * Activity (take 4, TEMPRA-115; tempra-dev: app/activity, decisions/three-activity-surfaces):
   * what happened in the library, in two views under one switch. By page (the default; Option B,
   * TEMPRA-308) has the agents working now on top, then each day's changes grouped by page, with
   * no times on the rows; Every event is the ledger as a table, with Download. `-/ledger` opens
   * Every event. Both follow the change feed. Nothing is marked "new since you looked"
   * (TEMPRA-173): a person comes here to look, and is not kept count of.
   * The view and filters (who, the folder) are in the URL, so a view can be linked and back and
   * forward restore it.
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
  const prefix = $derived((filters.prefix ?? "").replace(/\/+$/, ""));
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
  // write is remembered as writing now (Working now, the pulsing dots).
  const reload = useTrailing(() => loaded.reload());
  const live = useLiveWrites();
  const working = $derived(
    workingNow(live.writing, live.now, { who: filters.who ?? "everyone", prefix }),
  );
  useFeed(
    () => urls,
    () => loaded.data?.head ?? null,
    (events) => {
      live.heard(events);
      const hit = events.some(
        (e) =>
          (!exact || e.actor === exact) &&
          (inFolder(prefix, e.path) || inFolder(prefix, e.from_path)),
      );
      if (hit) reload();
    },
    () => {
      live.reset();
      reload();
    },
  );
</script>

<!-- Every event is a table, so it takes the wide column (TEMPRA-288). -->
<PageColumn wide={view === "events"}>
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
        { value: "summary", label: "By page" },
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
    <FolderFilter {prefix} onChange={(p) => go({ prefix: p || undefined })} />
    {#if view === "events"}
      <EventFilters kind={filters.kind ?? ""} q={filters.q ?? ""} onChange={(change) => go(change)} />
      <PillButton class="activity-download" icon="download" label="Download" href={urls.ledgerJsonl()} download />
    {/if}
  </div>
  <Status loaded={loaded.current}>
    {#snippet children(page)}
      {#key key}
        <Older {urls} {prefix} actor={exact} first={page}>
          {#snippet children(requests, more)}
            {#if view === "summary"}
              <ByPage
                {urls}
                {requests}
                empty={page.requests.length === 0}
                who={filters.who ?? "everyone"}
                {working}
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
