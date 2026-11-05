<script lang="ts">
  import AgentName from "../AgentName.svelte";
  import Avatar from "../Avatar.svelte";
  import type { EventRow } from "../activity";
  import type { ActorView } from "../agents";
  import Moment from "../Moment.svelte";
  import type { Urls } from "../urls";

  /** One row of Every event. */
  let {
    row,
    urls,
    actor,
    live,
    revert,
  }: {
    row: EventRow;
    urls: Urls;
    actor: ActorView;
    live: boolean;
    revert: boolean;
  } = $props();

  /** Events that made a version of a file, so a diff shows what they changed. */
  const DIFFABLE = new Set(["put", "import", "revert", "attach"]);

  const e = $derived(row.event);
  // A deleted file is shown as it was just before; a comment opens on its page.
  const href = $derived(
    e.op === "comment"
      ? urls.file(e.path)
      : urls.pinned(e.op === "delete" ? e.seq - 1 : e.seq).file(e.path),
  );
</script>

<tr class={row.lead ? "lead" : undefined}>
  <td class="events-seq">{#if live}<span class="change-dot live"><span class="visually-hidden">Being written now</span></span>{/if}{e.seq}</td>
  <td class="events-when">
    {#if row.lead}
      <Moment ts={e.ts} />
    {/if}
  </td>
  <td class="events-who">
    {#if row.lead}
      <span class="events-person"><Avatar name={actor.mark} fullName={actor.fullName} agent={actor.agent} tempra={actor.tempra} /><AgentName who={actor} /></span>
    {/if}
  </td>
  <td class="events-kind">{row.kind}</td>
  <td class="events-path"><a href={href}><code>{e.path}</code></a>{#if row.note}<span class="events-note">{row.note}</span>{/if}</td>
  <!-- The row's links in a column of their own, so the path and note keep their width (TEMPRA-288). -->
  <td class="events-actions">{#if DIFFABLE.has(e.op) && e.path.endsWith(".md")}<!-- This version as it was, on the page itself (History marks it there). --><a href={urls.diff(e.path, undefined, e.seq)}>Version</a>{/if}{#if revert}<a href={urls.revert(row.request.request_id)}>Revert…</a>{/if}</td>
</tr>
