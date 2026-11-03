<script lang="ts">
  import { Segmented } from "@tempra/design/components";
  import { threadElementId } from "../concept/panel";
  import { usePresence } from "../presence.svelte.ts";
  import type { Urls } from "../urls";
  import { type Draft, type Placed, panelOrder } from "./data";
  import NewComment from "./NewComment.svelte";
  import ThreadView from "./ThreadView.svelte";

  /**
   * The Comments panel's list (take 4, TEMPRA-114; tempra-dev: app/comments, In the app): Open and
   * Resolved n, a box to start a comment on the page (TEMPRA-172), or the draft in its place while
   * one is being written, then the threads in document order
   * (those on the whole concept and outdated ones first), the active one as a card, the others
   * compact. Its frame (title, count, ×) is the concept's Panel.
   */
  let props: {
    urls: Urls;
    /** The page; "" for the library's own threads, on its home (TEMPRA-222). */
    path: string;
    placed: Placed[];
    /** The threads could not be loaded (a new comment can still be made). */
    error: string | null;
    /** The threads are still loading. */
    loading: boolean;
    /** Comments can be made (the latest version; an earlier one shows its threads read-only). */
    writable: boolean;
    draft: Draft | null;
    onDraftDone(): void;
    active: string | null;
    onActive(id: string | null): void;
    onChanged(): void;
  } = $props();
  const onLibrary = $derived(props.path === "");
  // "Tempra is replying…" on the threads the library's agent is answering (TEMPRA-222).
  const presence = usePresence(() => props.urls);
  const open = $derived(panelOrder(props.placed, "open"));
  const resolved = $derived(panelOrder(props.placed, "resolved"));
  let tab = $state<"open" | "resolved">("open");
  let composing = $state(false);
  // A thread made active (a quote clicked, a link to it) shows under its tab, once it has
  // loaded; a thread resolved while it is active stays where it is. A draft is under Open.
  const activeStatus = $derived(props.placed.find((t) => t.id === props.active)?.status);
  let switched: string | null = null;
  $effect(() => {
    const active = props.active;
    const status = activeStatus;
    if (!active || !status || switched === active) return;
    switched = active;
    tab = status;
  });
  $effect(() => {
    if (props.draft) tab = "open";
  });

  // The active thread comes into view in the panel, once it is there.
  let list: HTMLDivElement | undefined = $state();
  let shown: string | null = null;
  $effect(() => {
    const active = props.active;
    // `placed` changes as threads load.
    void props.placed;
    void tab;
    if (!active || shown === active) return;
    const el = list?.querySelector(`[id="${CSS.escape(threadElementId(active))}"]`);
    if (!el) return;
    shown = active;
    el.scrollIntoView({ block: "nearest" });
  });

  function posted(id: string) {
    props.onActive(id);
    props.onChanged();
  }
  const threads = $derived(tab === "open" ? open : resolved);
</script>

<div class="comments-list" bind:this={list}
  ><Segmented
    label="Threads"
    options={[
      { value: "open", label: "Open" },
      { value: "resolved", label: `Resolved ${resolved.length}` },
    ]}
    bind:value={tab}
  />{#if props.error}<p class="small warn">Could not load the comments: {props.error}</p>{/if}{#if tab === "open" && props.draft}<NewComment
      urls={props.urls}
      path={props.path}
      draft={props.draft}
      onDone={props.onDraftDone}
      onPosted={posted}
    />{/if}{#if tab === "open" && !props.draft && composing}<NewComment
      urls={props.urls}
      path={props.path}
      draft={null}
      onDone={() => (composing = false)}
      onPosted={posted}
    />{/if}{#if tab === "open" && props.writable && !props.draft && !composing}<div class="new-thread-box"
      ><button type="button" class="new-thread" onclick={() => (composing = true)}
        >{onLibrary ? "Comment on the library…" : "Comment on the page…"}</button
      >{#if !onLibrary}<p class="small muted">Or select text to comment on it</p>{/if}</div
    >{/if}{#each threads as t (t.id)}<ThreadView
      urls={props.urls}
      thread={t}
      active={t.id === props.active}
      writable={props.writable}
      replying={presence.replying.has(t.id)}
      onActive={props.onActive}
      onChanged={props.onChanged}
    />{/each}{#if props.loading}<p class="small muted">Loading…</p>{/if}{#if !props.loading && threads.length === 0 && !props.draft && !composing}<p
      class="small muted">{tab === "resolved" ? "No resolved threads." : "No open threads."}</p
    >{/if}</div
>
