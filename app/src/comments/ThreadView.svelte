<script lang="ts">
  import AgentName from "../AgentName.svelte";
  import Avatar from "../Avatar.svelte";
  import { type ActorView, actorText } from "../agents";
  import { useActors } from "../agents.svelte.ts";
  import Moment from "../Moment.svelte";
  import { threadElementId } from "../page/panel";
  import { revealOffset } from "../reader/reading";
  import { clip } from "../ui";
  import type { Urls } from "../urls";
  import { type CommentT, commentParts, type Placed } from "./data";
  import ThreadActions from "./ThreadActions.svelte";

  /*
   * One comment thread as the Comments panel draws it (tempra-dev: app/comments): compact (its
   * quote, then who, the first words, when) until it is the active thread, a card with its
   * comments, a reply field and Resolve (Reopen once resolved). The composer for a new comment is
   * NewComment.svelte.
   */
  let props: {
    urls: Urls;
    thread: Placed;
    active: boolean;
    writable: boolean;
    /** The library's agent is working on a reply here (TEMPRA-222). */
    replying?: boolean;
    onActive(id: string | null): void;
    onChanged(): void;
  } = $props();

  // Names actors for comments: agents for their person, the signed-in person as "You".
  const actors = useActors(() => props.urls);
  const name = actors.view;
  const t = $derived(props.thread);
  const first = $derived(t.comments[0]);
  const outdated = $derived(t.anchor !== null && t.at === null);
  /** This library's own URL: its pages cited by URL read as their paths (TEMPRA-225). */
  const libraryUrl = $derived(`${location.origin}${props.urls.base}`);
  function select() {
    props.onActive(t.id);
    if (t.at) revealOffset(t.at.from);
  }
  // A compact thread expanded from the panel hands the focus to its card (C-25), which replaces
  // the button that had it.
  let card: HTMLElement | undefined = $state();
  let expanding = false;
  $effect(() => {
    if (!props.active || !expanding || !card) return;
    expanding = false;
    card.focus();
  });
</script>

<!-- Who said it: their mark and name, an agent with whom it acts for (AgentName). -->
{#snippet by(who: ActorView)}<Avatar name={who.mark} fullName={who.fullName} agent={who.agent} tempra={who.tempra} /><AgentName {who} />{/snippet}
<!-- A thread whose quote is no longer in the body, said where it shows; a request (TEMPRA-222). -->
{#snippet outdatedMark()}<span class="thread-outdated" title="The quoted text is no longer on the page">Outdated</span>{/snippet}
{#snippet marks()}{#if t.kind === "request"}<span class="thread-request" title="Left for people's agents to do">Request</span>{/if}{#if outdated}{@render outdatedMark()}{/if}{/snippet}
<!-- A comment's words, with the links it names (a URL, or a page by its path). -->
{#snippet words(body: string)}{#each commentParts(body, (p) => props.urls.file(p), libraryUrl) as part, i (i)}{#if "href" in part}<a href={part.href}>{part.text}</a>{:else}{part.text}{/if}{/each}{/snippet}
{#snippet comment(c: CommentT)}<div class="said"
    ><div class="said-by">{@render by(name(c.actor, c.by))} <Moment ts={c.ts} /></div
    ><p class="comment">{@render words(c.body)}</p></div
  >{/snippet}
{#if !props.active}
  <button
    type="button"
    id={threadElementId(t.id)}
    class={t.status === "open" ? "thread collapsed" : "thread collapsed resolved"}
    aria-expanded="false"
    onclick={() => {
      expanding = true;
      select();
    }}
    >{@render marks()}{#if t.anchor}<span class="quote thread-quote">{clip(t.anchor.quote, 120)}</span>{/if}<span
      class="thread-meta"
      >{#if first}{@render by(name(first.actor, first.by))}{/if}<span class="thread-words">{first ? clip(first.body, 80) : ""}</span
      >{#if t.replies > 0}<span class="thread-replies">{t.replies + 1}</span>{/if}{#if first}<Moment
          ts={t.comments[t.comments.length - 1]?.ts ?? first.ts}
        />{/if}</span
    >{#if props.replying}<span class="thread-replying">Tempra is replying…</span>{/if}</button
  >
{:else}
  <section
    bind:this={card}
    tabindex="-1"
    id={threadElementId(t.id)}
    class={t.status === "open" ? "thread open" : "thread open resolved"}
    aria-label="Comment thread"
    >{@render marks()}{#if t.anchor}<blockquote class="quote thread-quote"
        >{#if t.at}<a
            href={`#thread-${t.id}`}
            onclick={(e) => {
              e.preventDefault();
              select();
            }}>{clip(t.anchor.quote, 300)}</a
          >{:else}{clip(t.anchor.quote, 300)}{/if}</blockquote
      >{/if}<!-- The thread's comments and its resolves and reopens, in order. -->{#if !t.actions}{#each t.comments as c (c.id)}{@render comment(c)}{/each}{:else}{#each t.actions as a (a.seq)}{@const c = a.comment ? t.comments.find((x) => x.id === a.comment) : undefined}{#if a.kind === "resolve" || a.kind === "reopen"}<div
            ><p class="said-change">{a.kind === "resolve" ? "Resolved" : "Reopened"} by {actorText(name(a.actor, a.by))} <Moment ts={a.ts} /></p
            >{#if c}<p class="comment">{@render words(c.body)}</p>{/if}</div
          >{:else if c}{@render comment(c)}{/if}{/each}{/if}{#if props.replying}<p class="thread-replying" role="status">Tempra is replying…</p>{/if}<ThreadActions
      urls={props.urls}
      thread={props.thread}
      active={props.active}
      writable={props.writable}
      onActive={props.onActive}
      onChanged={props.onChanged}
    /></section
  >
{/if}
