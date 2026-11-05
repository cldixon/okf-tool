<script lang="ts">
  import {
    byPerson,
    continuesRun,
    entryTime,
    type Entry,
    groupByDay,
    type LedgerRequest,
    type LiveWrite,
    toEntry,
  } from "../activity";
  import { useActors } from "../agents.svelte.ts";
  import EntryRow from "../EntryRow.svelte";
  import { useTitleOf } from "../frame.svelte.ts";
  import LiveEntry from "../LiveEntry.svelte";
  import type { Urls, Who } from "../urls";

  /**
   * The Summary: the live entry, then one entry per request, by day; pages named by their titles
   * in the frame's index. `now` is the live clock, quick while an agent writes.
   */
  let {
    urls,
    requests,
    empty,
    who,
    writing,
    now,
  }: {
    urls: Urls;
    requests: LedgerRequest[];
    empty: boolean;
    who: Who;
    writing: LiveWrite | null;
    now: number;
  } = $props();

  const actors = useActors(() => urls);
  const titles = useTitleOf();
  const entries = $derived.by(() => {
    const ids = new Set<string>();
    const out: Entry[] = [];
    for (const r of requests) {
      if (ids.has(r.request_id)) continue;
      ids.add(r.request_id);
      if (who === "people" && !byPerson(r)) continue;
      if (who === "agents" && byPerson(r)) continue;
      const e = toEntry(r, titles.of);
      if (e) out.push(e);
    }
    return out;
  });
  const live = $derived(writing && who !== "people" ? writing : null);
  const days = $derived.by(() => {
    const days = groupByDay(entries, now);
    // The live entry heads today's entries (a day of its own when nothing else happened today).
    if (live && days[0]?.label !== "Today") days.unshift({ label: "Today", items: [] });
    return days;
  });
</script>

{#if entries.length === 0 && !live}
  <p class="view-empty">{empty ? "Nothing has happened here yet." : "Nothing matches."}</p>
{/if}
{#each days as day, i (day.label)}
  <section class="activity-day" aria-label={day.label}>
    <h2 class="view-section-title">{day.label}</h2>
    {#if i === 0 && live}
      <LiveEntry
        write={live}
        {urls}
        actor={actors.view(live.actor, live.by)}
        title={titles.of(live.path)}
      />
    {/if}
    {#each day.items as e, j (e.id)}
      <!-- A run of one person's changes is one block (TEMPRA-288); the live entry starts none. -->
      {@const prev = day.items[j - 1]}
      {@const continued = continuesRun(prev, e)}
      <EntryRow
        entry={e}
        {urls}
        actor={actors.view(e.actor, e.by)}
        {now}
        {continued}
        time={!continued || !prev || entryTime(prev.ts, now) !== entryTime(e.ts, now)}
      />
    {/each}
  </section>
{/each}
