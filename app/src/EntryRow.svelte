<script lang="ts">
  import { ChangeRow } from "@tempra/design/components";
  import AgentName from "./AgentName.svelte";
  import Avatar from "./Avatar.svelte";
  import {
    type Entry,
    entryTime,
    type Part,
    type Touched,
    withoutName,
    wordsText,
  } from "./activity";
  import type { ActorView } from "./agents";
  import { localTime } from "./ui";
  import { folderName, type Urls } from "./urls";

  /**
   * One Activity entry (a ChangeRow, TEMPRA-288): who (avatar, name, whom an agent acts for), what
   * they did, the note, the pages touched, and when. `continued` is a further entry of the same
   * person's run: the name and avatar are the first entry's, and the sentence starts with what
   * they did.
   */
  let {
    entry: e,
    urls,
    actor,
    now,
    continued = false,
    time = true,
  }: {
    entry: Entry;
    urls: Urls;
    actor: ActorView;
    now: number;
    continued?: boolean;
    /** Whether it says when; a run's further entry does not repeat the time above it. */
    time?: boolean;
  } = $props();
  const parts = $derived(continued ? withoutName(e.parts) : e.parts);

  /** How many touched pages an entry lists before "and n more". */
  const LISTED = 8;

  const href = (path: string, seq: number, gone: boolean) =>
    gone ? urls.pinned(seq - 1).file(path) : urls.file(path);
</script>

<!-- A piece of the sentence: text, a link to a page (as it was, when gone), or a folder's name. -->
{#snippet part(p: Part)}{#if typeof p === "string"}{p}{:else if "folder" in p}<!-- A folder is named, not linked: it is a group in the tree, not a page (TEMPRA-138). -->{folderName(p.folder)}{:else}{@const words = wordsText(p.words)}<a href={href(p.page, p.seq, p.gone)}>{p.title}</a>{#if words}<span class="entry-words">{` ${words}`}</span>{/if}{/if}{/snippet}

<!-- The pages an entry touched, each with what happened to it. -->
{#snippet touchedList(touched: Touched[])}
  {@const more = touched.length - Math.min(touched.length, LISTED)}
  <ul class="entry-touched">
    {#each touched.slice(0, LISTED) as t (t.path)}
      {@const words = wordsText(t.words)}
      <li><span class="entry-what">{t.what}</span><a href={href(t.path, t.seq, t.what === "deleted")}>{t.title}</a>{#if words}<span class="entry-words">{words}</span>{/if}{#if t.from}<span class="entry-words">from {t.from}</span>{/if}</li>
    {/each}
    {#if more > 0}
      <li class="entry-more">and {more} more</li>
    {/if}
  </ul>
{/snippet}

<ChangeRow {continued}>
  {#snippet lead()}<Avatar name={actor.mark} fullName={actor.fullName} agent={actor.agent} tempra={actor.tempra} />{/snippet}
  {#if continued}{#each parts as p}{@render part(p)}{/each}{:else}<AgentName who={actor} /> {#each parts as p}{@render part(p)}{/each}{/if}
  {#snippet detail()}
    {#if e.quote}
      <q class="entry-note">{e.quote}</q>
    {/if}
    {#if !e.named}
      {@render touchedList(e.touched)}
    {/if}
  {/snippet}
  {#snippet when()}{#if time}<time datetime={e.ts} title={localTime(e.ts)}>{entryTime(e.ts, now)}</time>{/if}{/snippet}
</ChangeRow>
