<script lang="ts">
  import { ChangeRow } from "@tempra/design/components";
  import AgentName from "../AgentName.svelte";
  import { bulkTitle, bulkVerb, type DayRow, doingText } from "../activity";
  import type { ActedBy, ActorView } from "../agents";
  import { dirOf, folderName, type Urls } from "../urls";

  /**
   * One row of Activity by page (Option B, TEMPRA-308), a bare ChangeRow: the page's title and
   * folder, the pulsing dot while an agent writes it, and one line of who did what to it that day
   * ("Edited twice by Claude Code for @dev, +252 −42 words · “note”"); or a request that changed
   * many pages at once ("11 new pages"). No time: the day's heading carries the date.
   */
  let {
    row,
    urls,
    view,
    writing = false,
  }: {
    row: DayRow;
    urls: Urls;
    view(actor: string, by: ActedBy | null): ActorView;
    /** An agent is writing this page now. */
    writing?: boolean;
  } = $props();

  /** A page's link: the home for the library itself, a deleted page as it was just before. */
  const href = (path: string, seq: number, gone: boolean) =>
    path === "" ? urls.tree("") : gone ? urls.pinned(seq - 1).file(path) : urls.file(path);

  /** "You" starts a line; anywhere else the signed-in person is "you" ("Checked by you"). */
  const named = (v: ActorView, start: boolean) => (v.you && !start ? { ...v, name: "you" } : v);
</script>

{#if row.kind === "page"}
  {@const folder = dirOf(row.path)}
  <ChangeRow class="activity-page">
    <a class="activity-page-title" href={href(row.path, row.seq, row.gone)}>{row.title}</a>{#if folder}<span class="activity-page-folder">{folderName(folder)}</span>{/if}{#if writing}<span class="change-dot live" aria-hidden="true"></span><span class="visually-hidden">, being edited now</span>{/if}
    {#snippet detail()}
      <p class="activity-page-line">{#each row.doings as d, i (i)}{@const t = doingText(d, i === 0)}{#if i > 0}{" · "}{/if}{t.before}<AgentName who={named(view(d.actor, d.by), i === 0 && t.before === "")} />{t.after}{/each}</p>
    {/snippet}
  </ChangeRow>
{:else}
  {@const more = row.count - row.pages.length}
  <ChangeRow class="activity-page">
    <span class="activity-page-title">{bulkTitle(row)}</span>{#if row.where}<span class="activity-page-folder">{row.where}</span>{/if}
    {#snippet detail()}
      <p class="activity-page-line">{bulkVerb(row)}<AgentName who={named(view(row.actor, row.by), false)} />{" · "}{#each row.pages as p, i (p.path)}{#if i > 0}{i === row.pages.length - 1 && more === 0 ? " and " : ", "}{/if}<a href={href(p.path, p.seq, p.gone)}>{p.title}</a>{/each}{#if more > 0}{` and ${more} more`}{/if}{#if row.quote}{` · “${row.quote}”`}{/if}</p>
    {/snippet}
  </ChangeRow>
{/if}
