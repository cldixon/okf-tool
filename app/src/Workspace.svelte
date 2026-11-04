<script lang="ts">
  import { type Snippet, untrack } from "svelte";
  import { api, cache } from "./api";
  import FeedNotice from "./FeedNotice.svelte";
  import type { Place } from "./frame";
  import { inboxChanged } from "./inbox";
  import LibrarySidebar from "./LibrarySidebar.svelte";
  import { useFeed } from "./live.svelte.ts";
  import { useLoad } from "./load.svelte.ts";
  import { isPagePath } from "./page/data";
  import { isShared, libraryLabel } from "./role";
  import { useLibrary } from "./role.svelte.ts";
  import Shell from "./Shell.svelte";
  import Switcher from "./Switcher.svelte";
  import { loadHidden, saveHidden } from "./sidebar";
  import TopbarPath from "./TopbarPath.svelte";
  import { type OutlineFile, REFRESH_MS } from "./tree";
  import type { Me } from "./ui";
  import { baseName, type Urls } from "./urls";
  import { useWake } from "./wake.svelte.ts";

  /**
   * A library's frame, keyed by the library so it stays mounted while the person moves within it:
   * the library in the bar (its name, switcher and search), the library's sidebar (on its
   * Settings page too, which is one of its pages), the quick switcher, the library's index, and the feed's
   * refresh of the inbox count.
   */
  let {
    urls,
    place,
    me,
    children,
  }: { urls: Urls; place: Place; me: Me | null; children: Snippet } = $props();
  let hidden = $state(loadHidden(untrack(() => urls)));
  let switching = $state(false);
  const library = useLibrary(() => urls);
  // A library's object may have gone to sleep while the person read: the first sign they are
  // back wakes it, so the page they open next does not wait for it (TEMPRA-195).
  useWake(() => urls);
  const name = $derived(libraryLabel(library.current ?? urls));

  // The library's index (`GET …/outline`: every file's path, kind, title and seq, no bodies),
  // loaded once for the frame: the tree, the quick switcher and the pages (`frame.index`,
  // useTitleOf) read it. It is asked afresh on entering the library, not drawn from the cache,
  // since the feed starts from its seq.
  untrack(() => cache.drop(`outline ${urls.base}`));
  const outline = useLoad(
    () => `outline ${urls.base}`,
    () => api<{ seq: number; files: OutlineFile[] }>(urls.api("outline")),
  );
  // The index as last loaded (a refresh that fails keeps it), and the seq the feed starts from:
  // set once, from the first answer, and again after a restore.
  let index = $state.raw<OutlineFile[] | null>(null);
  let synced = $state<number | null>(null);
  $effect(() => {
    const d = outline.data;
    if (!d) return;
    index = d.files;
    if (untrack(() => synced) === null) synced = d.seq;
  });
  let loadedAt = Date.now();
  function refresh() {
    loadedAt = Date.now();
    outline.reload();
  }

  // Live: the index is refreshed shortly after a write, and at most every REFRESH_MS while agents
  // keep writing (each refresh reads the whole index). A comment, a write or a verification may
  // make, change or close an item of the person's (TEMPRA-116): the inbox's count reloads a
  // moment after a burst (items are written just after the write commits).
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inboxTimer: ReturnType<typeof setTimeout> | undefined;
  $effect(() => () => {
    clearTimeout(timer);
    clearTimeout(inboxTimer);
  });
  useFeed(
    () => urls,
    () => synced,
    (events) => {
      if (events.length === 0) return;
      // Once for a burst, 1.5 s after its first write (not after it ends: agents may not pause).
      inboxTimer ??= setTimeout(() => {
        inboxTimer = undefined;
        inboxChanged();
      }, 1500);
      if (timer !== undefined) return;
      timer = setTimeout(
        () => {
          timer = undefined;
          refresh();
        },
        Math.max(300, loadedAt + REFRESH_MS - Date.now()),
      );
    },
    () => {
      // The ledger went back (a restore): start again from the new index.
      synced = null;
      refresh();
    },
  );

  function hide(h: boolean) {
    hidden = h;
    saveHidden(urls, h);
  }
  // Ctrl or Cmd+K opens the quick switcher, and again closes it (on the Settings page too;
  // TEMPRA-127).
  $effect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        switching = !switching;
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  });
  const shared = $derived(library.current !== undefined && isShared(library.current));
</script>

<!-- The path of a page being moved to, from the index, while the page on screen waits. -->
{#snippet nextPath()}{#if place.file && isPagePath(place.file)}<TopbarPath
      path={place.file}
      title={index?.find((f) => f.path === place.file)?.title ?? baseName(place.file).replace(/\.md$/, "")}
    />{/if}{/snippet}
<Shell
  library={{ urls, name, shared, home: place.view === "home" }}
  onSearch={() => (switching = true)}
  {hidden}
  onHide={hide}
  {me}
  {index}
  {nextPath}
>
  {#snippet sidebar()}
    <LibrarySidebar {urls} {place} files={index} failed={outline.state === "error"} onRetry={refresh} />
  {/snippet}
  {#snippet status()}<FeedNotice {urls} />{/snippet}
  {@render children()}
</Shell>
<Switcher {urls} {name} index={index ?? []} open={switching} onClose={() => (switching = false)} />
