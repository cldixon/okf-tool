<script lang="ts">
  import AgentName from "../AgentName.svelte";
  import Avatar from "../Avatar.svelte";
  import { type ActorView, actorText } from "../agents";
  import Moment from "../Moment.svelte";
  import { presenceTitle } from "../presence";
  import { usePresence } from "../presence.svelte.ts";
  import type { Urls } from "../urls";
  import type { Namer } from "./byline";
  import { actedBy, type HistoryEvent, type PageFile, standing } from "./data";
  import StatusPills from "./StatusPills.svelte";

  /**
   * The page's byline (take 4, TEMPRA-114; tempra-dev: app/reader, The byline), above the title:
   * who wrote the version on screen, for whom when an agent ("Claude Code for @ann"), and when
   * ("edited 14 min ago"). It follows the version on screen: an earlier one shows who wrote it and
   * when. An agent reading or writing the page now (presence, TEMPRA-219: fading 8 s after its last
   * read or write) shimmers as its row in the tree does, with no words: the author's name when it
   * is the one at it, else that agent added after it ("… & Codex for @ann"); not over an earlier
   * version.
   * Versions are in Page info; whether a person checked the page is the quiet line under the
   * description (`CheckedLine.svelte`). At its end, grey pills say what is exceptional: a status
   * that is not stable ("Draft") and "Stale" (TEMPRA-139).
   */
  let props: {
    urls: Urls;
    page: PageFile;
    history: HistoryEvent[];
    name: Namer;
    /** The latest version is on screen: presence is the page's now, not an earlier version's. */
    current: boolean;
    /** The page's `status` from its frontmatter, if any. */
    status?: string | null;
  } = $props();

  const s = $derived(standing(props.history, props.page.seq));
  const author = $derived(s.current?.event);
  const who = $derived(author ? props.name(author.actor, actedBy(author)) : null);

  const presence = usePresence(() => props.urls);
  const here = $derived(props.current ? presence.active.get(props.page.path) : undefined);
  const at = $derived(here ? props.name(here.actor, here.by) : null);
  // The author is the one at it: its own name shimmers; another agent is named after it.
  const atIsAuthor = $derived(at !== null && who !== null && actorText(at) === actorText(who));
  const other = $derived(at && !atIsAuthor ? at : null);
</script>

<!-- Who from when: a thin slanted rule, as a blog post's byline has. -->
{#snippet name(v: ActorView, busy: boolean)}<span
    class={busy ? "byline-name presence" : "byline-name"}
    title={busy && here ? presenceTitle(actorText(v), here.kind) : undefined}
    data-presence={busy && here ? here.kind : undefined}
    ><AgentName who={v} />{#if busy && here}<span class="visually-hidden">{`, ${here.kind} now`}</span>{/if}</span
  >{/snippet}
{#snippet sep()}<span class="byline-slash" aria-hidden="true"></span>{/snippet}
{#if !who || !author}
  <div class="byline"><StatusPills status={props.status ?? null} stale={props.page.stale} /></div>
{:else}
  <div class="byline"
    ><Avatar name={who.mark} fullName={who.fullName} agent={who.agent} tempra={who.tempra} />{@render name(who, atIsAuthor)}{#if other}<span class="byline-and">&amp;</span
      ><Avatar name={other.mark} fullName={other.fullName} agent={other.agent} tempra={other.tempra} />{@render name(other, true)}{/if}{@render sep()}<span class="muted">edited <Moment ts={author.ts} /></span
    ><StatusPills status={props.status ?? null} stale={props.page.stale} /></div>
{/if}
