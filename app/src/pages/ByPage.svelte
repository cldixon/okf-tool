<script lang="ts">
  import { byPage, type LedgerRequest, type LiveWrite } from "../activity";
  import { useActors } from "../agents.svelte.ts";
  import { useTitleOf } from "../frame.svelte.ts";
  import type { Urls, Who } from "../urls";
  import PageDayRow from "./PageDayRow.svelte";
  import WorkingNow from "./WorkingNow.svelte";

  /**
   * Activity by page (Option B, TEMPRA-308): the agents working now, then each day under its
   * heading with a row per page changed that day; pages named by their titles in the frame's
   * index. `now` is the live clock (the day headings), `working` the agents writing now, newest
   * first (workingNow).
   */
  let {
    urls,
    requests,
    empty,
    who,
    working,
    now,
  }: {
    urls: Urls;
    requests: LedgerRequest[];
    empty: boolean;
    who: Who;
    working: LiveWrite[];
    now: number;
  } = $props();

  const actors = useActors(() => urls);
  const titles = useTitleOf();
  const days = $derived(byPage(requests, titles.of, now, who));
  const writing = $derived(new Set(working.map((w) => w.path)));
</script>

<WorkingNow
  {urls}
  {working}
  view={(a, by) => actors.view(a, by)}
  titleOf={(p) => titles.of(p)}
/>
{#if days.length === 0 && working.length === 0}
  <p class="view-empty">{empty ? "Nothing has happened here yet." : "Nothing matches."}</p>
{/if}
{#each days as day (day.label)}
  <section class="activity-day" aria-label={day.label}>
    <h2 class="activity-day-title">{day.label}</h2>
    {#each day.rows as row (row.key)}
      <PageDayRow
        {row}
        {urls}
        view={(a, by) => actors.view(a, by)}
        writing={row.kind === "page" && writing.has(row.path)}
      />
    {/each}
  </section>
{/each}
