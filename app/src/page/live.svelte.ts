import { untrack } from "svelte";
import { composing } from "../comments/composing.svelte.ts";
import type { FeedEvent } from "../live";
import { useFeed } from "../live.svelte.ts";
import type { Urls } from "../urls";
import type { FileData } from "./data";
import type { Live } from "./live";

/**
 * Follows the open file on the change feed: someone else's change to it (null when there is
 * none), and its comments' changes (`onComment`). The change swaps in once the reader is idle.
 */
export function useLiveFile(
  urls: () => Urls,
  shown: () => FileData | null,
  actor: () => string,
  reload: () => void,
  onComment: () => void,
) {
  let change = $state.raw<FeedEvent | null>(null);
  const swap = () => {
    change = null;
    reload();
  };
  useFeed(
    urls,
    () => {
      const s = shown();
      return urls().at === undefined && s ? s.head : null;
    },
    (events) => {
      const s = shown();
      if (urls().at !== undefined || !s) return;
      const path = s.file.path;
      if (events.some((e) => e.op === "comment" && e.path === path)) onComment();
      const mine = events.filter(
        (e) =>
          e.seq > s.head &&
          (e.path === path || e.from_path === path) &&
          e.op !== "comment" &&
          e.actor !== actor(),
      );
      const last = mine[mine.length - 1];
      if (last) change = last;
    },
    swap,
  );
  // A page drawn from the cache catches up in the background: a change it now shows is no news.
  $effect(() => {
    const s = shown();
    if (change && s && change.seq <= s.head) change = null;
  });
  const idle = useIdle(15_000);
  const swappable = $derived(change !== null && change.op !== "delete" && change.op !== "move");
  $effect(() => {
    if (swappable && idle.current) untrack(swap);
  });
  const live = $derived.by((): Live | null => {
    const s = shown();
    return change && s ? { change, shownSeq: s.file.seq, onSwap: swap } : null;
  });
  return {
    get current() {
      return live;
    },
  };
}

/**
 * True once the person has not scrolled, typed, clicked or selected text for `ms`, and is not
 * writing a comment (a draft, a comment or a reply with text): the moment a new version may
 * replace what they are reading without pulling it from under them.
 */
function useIdle(ms: number) {
  let idle = $state(false);
  $effect(() => {
    let last = Date.now();
    const busy = () => {
      last = Date.now();
      idle = false;
    };
    const kinds = ["scroll", "wheel", "keydown", "pointerdown", "selectionchange"] as const;
    for (const k of kinds) document.addEventListener(k, busy, { passive: true, capture: true });
    const timer = setInterval(() => {
      const selecting = !(document.getSelection()?.isCollapsed ?? true);
      idle = !selecting && !composing() && Date.now() - last >= ms;
    }, 1000);
    return () => {
      clearInterval(timer);
      for (const k of kinds) document.removeEventListener(k, busy, { capture: true });
    };
  });
  return {
    get current() {
      return idle;
    },
  };
}
