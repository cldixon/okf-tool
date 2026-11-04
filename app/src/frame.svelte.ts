import { getContext, setContext } from "svelte";
import type { OutlineFile } from "./tree";
import { baseName } from "./urls";

/** What a page in the workspace may ask of the frame. Read its fields where they are used. */
export interface Frame {
  /** The sidebar is beside the page (not hidden, not a drawer). */
  readonly sidebar: boolean;
  /** The phone layout: a top bar, the sidebar as a drawer. */
  readonly narrow: boolean;
  /** The library's index (`GET …/outline`, as the workspace loaded it); null until it arrives. */
  readonly index: OutlineFile[] | null;
  /** The top bar's slots a page fills through PageBar: its path, its tools. */
  readonly slots: { tools: HTMLElement | null; path: HTMLElement | null };
  /** A page's overlay (a page's panel over the page) is modal: the top bar and sidebar go inert. */
  setModal(on: boolean): void;
  /** Opens search: a library's quick switcher, or the search of the person's libraries. */
  search(): void;
}

const NONE: Frame = {
  sidebar: true,
  narrow: false,
  index: null,
  slots: { tools: null, path: null },
  setModal: () => {},
  search: () => {},
};

const KEY = Symbol("frame");

/** The frame provides itself to the pages inside it (Workspace.svelte, AccountFrame.svelte). */
export function provideFrame(frame: Frame) {
  setContext(KEY, frame);
}

/** The workspace's frame, for pages that lay themselves out by it. */
export function useFrame(): Frame {
  return getContext<Frame | undefined>(KEY) ?? NONE;
}

/**
 * Pages' titles by path, from the index the tree loaded (the file name until it arrives). Call
 * `.of(path)` where it is drawn; it follows the index.
 */
export function useTitleOf() {
  const frame = useFrame();
  const titles = $derived.by(() => {
    const m = new Map<string, string>();
    for (const f of frame.index ?? []) if (f.title) m.set(f.path, f.title);
    return m;
  });
  return {
    of: (path: string) => titles.get(path) ?? baseName(path).replace(/\.md$/, ""),
  };
}

/** Whether a media query matches, following resizes. */
export function useMedia(query: () => string) {
  let on = $state(typeof window === "undefined" ? false : window.matchMedia(query()).matches);
  $effect(() => {
    const m = window.matchMedia(query());
    const update = () => {
      on = m.matches;
    };
    update();
    m.addEventListener("change", update);
    return () => m.removeEventListener("change", update);
  });
  return {
    get current() {
      return on;
    },
  };
}
