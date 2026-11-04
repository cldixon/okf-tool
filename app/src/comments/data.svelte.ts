import type { DocText } from "@tempra/editor";
import { api } from "../api";
import { useLoad } from "../load.svelte.ts";
import type { Urls } from "../urls";
import type { Draft, Thread } from "./data";

/** A page's threads, open and resolved (a page rarely has more than a page of them). */
export function useThreads(urls: () => Urls, path: () => string | null) {
  return useLoad(
    () => `comments ${urls().api("comments")} ${path() ?? ""}`,
    async () => {
      const p = path();
      return p === null
        ? { threads: [] as Thread[] }
        : api<{ threads: Thread[] }>(
            urls().api("comments", { path: p, status: "all", limit: 200 }),
          );
    },
  );
}

/**
 * The draft comment's quote: started from the reader's selection toolbar, kept (highlighted)
 * while the comment is written, until it is posted or dropped.
 */
export function useDraft(text: () => DocText) {
  let draft = $state.raw<Draft | null>(null);
  // A new version of the body: the old offsets no longer apply.
  $effect(() => {
    void text();
    draft = null;
  });
  return {
    get draft() {
      return draft;
    },
    start({ from, to }: { from: number; to: number }) {
      if (from < 0 || to <= from) return;
      const quote = text().text.slice(from, to);
      if (quote.trim()) draft = { quote, from, to };
    },
    clear() {
      draft = null;
    },
  };
}
