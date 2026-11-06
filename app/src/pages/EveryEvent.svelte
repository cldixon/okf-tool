<script lang="ts">
  import { eventRows, type LedgerRequest } from "../activity";
  import { useActors } from "../agents.svelte.ts";
  import { useRole } from "../role.svelte.ts";
  import { plural } from "../ui";
  import type { Urls, Who } from "../urls";
  import EventLine from "./EventLine.svelte";

  /**
   * Every event: the ledger as a table, newest first. Who and when are named on a request's first
   * row; a row an agent's fresh write made carries the pulsing dot. A request's first row links
   * its revert for the owner.
   */
  let {
    urls,
    requests,
    empty,
    filter,
    more,
    pulses,
  }: {
    urls: Urls;
    requests: LedgerRequest[];
    empty: boolean;
    filter: { who?: Who; kind?: string; q?: string };
    /** Older requests are still to load ("Older"). */
    more: boolean;
    /** Whether the event with this seq is an agent's fresh write (by the live clock). */
    pulses(seq: number): boolean;
  } = $props();

  const actors = useActors(() => urls);
  const role = useRole(() => urls);
  const rows = $derived(eventRows(requests, filter));
  // Who (Agents, People), the kind and the text filter what is loaded, not the whole ledger: say
  // so while older requests remain, and "Older" pages on.
  const partial = $derived(
    more &&
      (Boolean(filter.kind) ||
        Boolean(filter.q) ||
        (filter.who !== undefined && filter.who !== "everyone")),
  );
  const scope = $derived(`in the latest ${plural(requests.length, "request")}`);
</script>

{#if rows.length === 0}
  <p class="view-empty">
    {empty ? "Nothing has happened here yet." : partial ? `No events match ${scope}.` : "No events match."}
  </p>
{:else}
  {#if partial}
    <p class="view-meta events-scope">Matching events {scope}</p>
  {/if}
  <div class="table-wrap">
    <table class="events-table">
      <thead>
        <tr>
          <th scope="col">Seq</th>
          <th scope="col">When</th>
          <th scope="col">Who</th>
          <th scope="col">Kind</th>
          <th scope="col">Path and note</th>
          <th scope="col"><span class="visually-hidden">Links</span></th>
        </tr>
      </thead>
      <tbody>
        {#each rows as row (row.event.seq)}
          <EventLine
            {row}
            {urls}
            actor={actors.view(row.request.actor, row.request.by)}
            live={pulses(row.event.seq)}
            revert={
              // Revert is one of the owner's recovery tools (TEMPRA-124).
              row.lead &&
              role.current === "owner" &&
              row.request.events.some((e) => e.op !== "verify" && e.op !== "comment")
            }
          />
        {/each}
      </tbody>
    </table>
  </div>
{/if}
