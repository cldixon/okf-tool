<script lang="ts">
  import { Icon } from "@tempra/design/components";
  import { untrack } from "svelte";
  import { actorText } from "./agents";
  import { useActors } from "./agents.svelte.ts";
  import {
    activeFolders,
    type Presence,
    presenceTitle,
    presenceWords,
    presenceWordsInside,
  } from "./presence";
  import { usePresence } from "./presence.svelte.ts";
  import {
    ancestors,
    buildDirs,
    fileLabel,
    insideDirs,
    loadClosed,
    type OutlineFile,
    rollUp,
    saveClosed,
  } from "./tree";
  import { folderName, type Urls } from "./urls";

  /**
   * The library's file tree (tempra-dev: app/workspace). The whole index (paths, titles,
   * sequences; no bodies; Workspace loads it in one small request and keeps it following the
   * feed) is here at once, so opening a folder never waits. A folder (named for people) is a
   * group, not a page: its row (its name as a section's label, the chevron at its end, as
   * Linear's docs draw it; TEMPRA-277) opens and closes it (TEMPRA-138), and a
   * folder's address reveals it here. Every folder starts open; the ones the person closed are
   * remembered on this browser, and the open file is revealed and marked. A closed folder rolls
   * up the marks of what is inside it. Change is not marked here (TEMPRA-173): Activity is where
   * a person looks for it. What an agent is doing now is (TEMPRA-219): the name of a file it is
   * reading or writing shimmers, with no words beside it (a hover names the agent, "Claude Code
   * for @dev is reading"), fading a few seconds after the agent moves on. A closed folder holding
   * one shimmers its own name instead; opened, the shimmer moves at once to the rows inside that
   * hold it (a page, or a closed folder deeper down), and an open folder never shimmers itself.
   * A search marks nothing.
   */
  let props: {
    urls: Urls;
    file: string | null;
    dir: string | null;
    /** The library's index; null until it arrives. */
    files: OutlineFile[] | null;
    /** Loading the index failed (and there is none to show): Retry asks again. */
    failed: boolean;
    onRetry(): void;
  } = $props();

  let closed = $state.raw(loadClosed(untrack(() => props.urls)));
  const isOpen = (dir: string) => !closed.has(dir);
  const dirs = $derived(props.files ? buildDirs(props.files) : null);
  const inside = $derived(props.files ? insideDirs(props.files) : new Map<string, OutlineFile[]>());
  const presence = usePresence(() => props.urls);
  const busyFolders = $derived(activeFolders(presence.active));
  // Who is at a marked row, for its tooltip, named as the app names agents (TEMPRA-131).
  const actors = useActors(() => props.urls);
  const rowTitle = (label: string, p: Presence | undefined, inside = false) =>
    p ? `${label}: ${presenceTitle(actorText(actors.view(p.actor, p.by)), p.kind, inside)}` : label;

  // The open file's folders are revealed when it opens (and may be collapsed after); so is a
  // folder whose address was opened (`dir`, on its way to the home).
  const current = $derived(props.file ?? props.dir);
  /** A folder being revealed: its row is scrolled into view when it first draws. */
  let revealing = $state<string | null>(null);
  $effect(() => {
    const file = props.file;
    const cur = current;
    const urls = props.urls;
    if (cur === null) return;
    if (file === null) revealing = cur;
    const up = file !== null ? ancestors(file) : [...ancestors(cur), cur];
    const want = up.filter((d) => d !== "");
    untrack(() => {
      const c = closed;
      if (!want.some((d) => c.has(d))) return;
      const next = new Set([...c].filter((d) => !want.includes(d)));
      saveClosed(urls, next);
      closed = next;
    });
  });

  function toggle(dir: string) {
    const next = new Set(closed);
    if (next.has(dir)) next.delete(dir);
    else next.add(dir);
    saveClosed(props.urls, next);
    closed = next;
  }

  // The open file's (or revealed folder's) row is scrolled into view once, when it opens (not
  // after every refresh, which would pull the person back while agents write).
  let currentRow = $state.raw<HTMLElement | null>(null);
  const markCurrent = (el: HTMLElement) => {
    currentRow = el;
    return () => {
      if (currentRow === el) currentRow = null;
    };
  };
  let scrolledTo: string | null = null;
  $effect(() => {
    const cur = current;
    const row = currentRow;
    void dirs;
    // The row may first appear when the index arrives; it must be this file's, not the last.
    if (scrolledTo === cur || !row || row.dataset.path !== cur) return;
    scrolledTo = cur;
    // After the first paint: scrolling reads layout, which would hold back drawing the page.
    requestAnimationFrame(() => row.scrollIntoView({ block: "nearest" }));
  });
  /** A revealed folder's row scrolls into view when it draws. */
  const reveal = (path: string) => (el: HTMLElement) => {
    if (revealing === path) {
      revealing = null;
      el.scrollIntoView({ block: "nearest" });
    }
  };

  const s = (n: number) => (n === 1 ? "" : "s");
</script>

{#snippet mark(comments: number | undefined, stale: OutlineFile["stale"])}{#if comments}<span
      class="tree-mark"
      title={`${comments} open comment${s(comments)}`}
      ><span aria-hidden="true">{comments}</span><span class="visually-hidden"
        >{comments} open comment{s(comments)}</span
      ></span
    >{/if}{#if stale}<span class="tree-mark" title={stale === "stale" ? "Stale" : "Stale soon"}
      ><span aria-hidden="true"><Icon name={stale === "stale" ? "stale" : "soon"} size={12} /></span
      ><span class="visually-hidden">{stale === "stale" ? "stale" : "stale soon"}</span></span
    >{/if}{/snippet}

{#snippet rolledUp(dir: string)}{@const r = rollUp(inside.get(dir) ?? [])}{@render mark(
    r.comments,
    r.stale,
  )}{/snippet}

{#snippet rows(dir: string)}
  {#if dirs === null && props.failed}
    <li class="tree-note">Could not load the files.{" "}<button type="button" onclick={props.onRetry}>Retry</button></li>
  {:else if dirs === null}
    <li class="tree-note">Loading…</li>
  {:else if (dirs[dir] ?? []).length === 0 && dir === ""}
    <li class="tree-note">No pages yet.</li>
  {:else}
    {#each dirs[dir] ?? [] as e (e.path)}
      {#if e.kind === "dir"}
        {@const inHere = isOpen(e.path) ? undefined : busyFolders.get(e.path)}
        <li>
          <!-- A folder is a group, not a page (TEMPRA-138): its whole row opens and closes it.
               Only a closed folder shimmers for what is inside it; an open one leaves it to its
               rows (TEMPRA-219). -->
          <div
            class={`tree-row dir${isOpen(e.path) ? " open" : ""}${inHere ? " presence" : ""}`}
            ><button
              type="button"
              class="tree-name"
              aria-expanded={isOpen(e.path)}
              title={rowTitle(folderName(e.path), inHere, true)}
              data-presence={inHere?.kind}
              {@attach reveal(e.path)}
              onclick={() => toggle(e.path)}
              >{folderName(e.path)}</button
            >{#if inHere}<span class="visually-hidden">{presenceWordsInside[inHere.kind]}</span
              >{/if}{#if !isOpen(e.path)}{@render rolledUp(e.path)}{/if}<span
              class="tree-chevron"
              aria-hidden="true"><Icon name="chevron" /></span
            ></div
          >{#if isOpen(e.path)}<ul>{@render rows(e.path)}</ul>{/if}</li
        >
      {:else}
        {@const here = presence.active.get(e.path)}
        {@const busy = here?.kind}
        <li>
          <div class={`tree-row${e.kind === "attachment" ? " file" : ""}${busy ? " presence" : ""}`}
            ><span class="tree-leaf"
              >{#if e.kind === "attachment"}<Icon name="file" size={14} />{/if}</span
            ><a
              href={props.urls.file(e.path)}
              title={rowTitle(fileLabel(e), here)}
              class={busy ? "presence" : undefined}
              data-path={e.path}
              data-presence={busy}
              aria-current={props.file === e.path ? "page" : undefined}
              {@attach props.file === e.path ? markCurrent : undefined}>{fileLabel(e)}</a
            >{#if busy}<span class="visually-hidden">{presenceWords[busy]}</span>{/if}{@render mark(
              e.comments,
              e.stale,
            )}</div
          >
        </li>
      {/if}
    {/each}
  {/if}
{/snippet}

<nav aria-label="Files">
  <ul class="tree">{@render rows("")}</ul>
</nav>
