import { api } from "./api";
import { useLoad, WORKSPACE_DATA } from "./load.svelte.ts";
import type { Me } from "./ui";
import { copyText } from "./ui";

/** The signed-in person, loaded once for the whole app (the same load App.svelte makes). */
export function useMe() {
  const me = useLoad(
    () => "me",
    () => api<Me>("/api/v1/me"),
    [],
    WORKSPACE_DATA,
  );
  return {
    get current(): Me | null {
      return me.data ?? null;
    },
  };
}

/** Sets the document title, as the server pages do: "{title} · Tempra". */
export function useTitle(title: () => string | null) {
  $effect(() => {
    const t = title();
    if (t) document.title = `${t} · Tempra`;
  });
}

/** After a page's data arrives, scrolls to the #fragment the URL names, if any. */
export function useScrollToHash(ready: () => boolean) {
  $effect(() => {
    if (!ready() || !location.hash) return;
    let id: string;
    try {
      id = decodeURIComponent(location.hash.slice(1));
    } catch {
      // A malformed escape (an agent wrote the link): use the fragment as it is.
      id = location.hash.slice(1);
    }
    document.getElementById(id)?.scrollIntoView();
  });
}

/**
 * The clock relative times are read against, ticking so "2 min ago" stays true. `ms` may follow
 * state (quick while something reads as live, slow otherwise): the timer is set again only when
 * the interval itself changes.
 */
export function useNow(ms: number | (() => number) = 30_000) {
  let now = $state(Date.now());
  const interval = $derived(typeof ms === "number" ? ms : ms());
  $effect(() => {
    const t = setInterval(() => {
      now = Date.now();
    }, interval);
    return () => clearInterval(t);
  });
  return {
    get current() {
      return now;
    },
  };
}

/**
 * One clock for every Moment on the page, ticking every 30 s while any is drawn: a list of a
 * hundred times keeps one timer, not a hundred.
 */
const shared = $state({ now: Date.now() });
let readers = 0;
let sharedTimer: ReturnType<typeof setInterval> | undefined;

export function useSharedNow() {
  $effect(() => {
    if (readers++ === 0) {
      shared.now = Date.now();
      sharedTimer = setInterval(() => {
        shared.now = Date.now();
      }, 30_000);
    }
    return () => {
      if (--readers === 0) clearInterval(sharedTimer);
    };
  });
  return {
    get current() {
      return shared.now;
    },
  };
}

/**
 * Copies text from a click (or text fetched for it, as Copy page fetches the file); `state` says
 * "copied" (or "failed") for 1.5 s from the latest click, and `tip` says it in words for a
 * button's `tip` ("Copied", "Couldn't copy"; null between; TEMPRA-312).
 */
export function useCopy() {
  let state = $state<"idle" | "copied" | "failed">("idle");
  let presses = $state(0);
  $effect(() => {
    void presses;
    if (state === "idle") return;
    const t = setTimeout(() => {
      state = "idle";
    }, 1500);
    return () => clearTimeout(t);
  });
  const done = (next: "copied" | "failed") => {
    state = next;
    presses++;
  };
  return {
    get state() {
      return state;
    },
    get tip(): string | null {
      return state === "copied" ? "Copied" : state === "failed" ? "Couldn't copy" : null;
    },
    copy: (text: string | (() => Promise<string>)) =>
      (typeof text === "string" ? navigator.clipboard.writeText(text) : copyText(text)).then(
        () => done("copied"),
        () => done("failed"),
      ),
  };
}
