<script lang="ts">
  import AgentName from "../AgentName.svelte";
  import Avatar from "../Avatar.svelte";
  import Moment from "../Moment.svelte";
  import type { Namer } from "./byline";
  import { actedBy, type HistoryEvent, type PageFile, standing } from "./data";
  import StatusPills from "./StatusPills.svelte";

  /**
   * The page's byline (take 4, TEMPRA-114; tempra-dev: app/reader, The byline), above the title:
   * who wrote the version on screen, for whom when an agent ("Claude Code for @ann"), and when
   * ("edited 14 min ago"). It follows the version on screen: an earlier one shows who wrote it and
   * when. It no longer says "editing now" (a trial: an agent at work is to be shown another way).
   * Versions are in Page info; whether a person checked the page is the quiet line under the
   * description (`CheckedLine.svelte`). At its end, grey pills say what is exceptional: a status
   * that is not stable ("Draft") and "Stale" (TEMPRA-139).
   */
  let props: {
    page: PageFile;
    history: HistoryEvent[];
    name: Namer;
    /** The page's `status` from its frontmatter, if any. */
    status?: string | null;
  } = $props();

  const s = $derived(standing(props.history, props.page.seq));
  const author = $derived(s.current?.event);
  const who = $derived(author ? props.name(author.actor, actedBy(author)) : null);
</script>

{#snippet sep()}<span class="byline-sep" aria-hidden="true">·</span>{/snippet}
{#if !who || !author}
  <div class="byline"><StatusPills status={props.status ?? null} stale={props.page.stale} /></div>
{:else}
  <div class="byline"
    ><Avatar name={who.mark} fullName={who.fullName} agent={who.agent} tempra={who.tempra} /><span class="byline-name"><AgentName {who} /></span
    >{@render sep()}<span class="muted">edited <Moment ts={author.ts} /></span
    ><StatusPills status={props.status ?? null} stale={props.page.stale} /></div>
{/if}
