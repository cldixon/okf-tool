<script lang="ts">
  import type { Snippet } from "svelte";
  import { useFrame } from "../frame.svelte.ts";

  /**
   * A page's frame (take 4, TEMPRA-114; TEMPRA-283), shared by a page and the library's home: the
   * text in its column and on the right the side column, which holds the corner row and the
   * contents or one panel (the stylesheet, page.css, decides what fits). Where the open panel
   * overlays the page (under 960px of page, and the phone's sheet: read from the panel's
   * position), it is modal (C-26, P-4): the text, the top bar and the sidebar it dims are inert,
   * and a tap on the dimmed page closes it.
   */
  let {
    open,
    classes = "",
    onScrim,
    before,
    text,
    side,
    sideBox = $bindable(),
  }: {
    /** A panel is open in the side column. */
    open: boolean;
    /** More of the frame's classes (`markdown-on`). */
    classes?: string;
    /** A tap on the page dimmed behind an overlaid panel. */
    onScrim(): void;
    /** Drawn first, in the frame (a page's part of the top bar). */
    before?: Snippet;
    text: Snippet;
    side: Snippet;
    /** The side column's element: where the panel is. */
    sideBox?: HTMLDivElement;
  } = $props();

  const frame = useFrame();
  let overlaid = $state(false);
  let page: HTMLDivElement | undefined = $state();
  $effect(() => {
    if (!open) {
      overlaid = false;
      return;
    }
    const measure = () => {
      const el = sideBox?.querySelector(".page-aside");
      overlaid = el ? getComputedStyle(el).position === "fixed" : false;
    };
    measure();
    const watch = new ResizeObserver(measure);
    if (page) watch.observe(page);
    return () => watch.disconnect();
  });
  const modal = $derived(open && overlaid);
  $effect(() => {
    frame.setModal(modal);
    return () => frame.setModal(false);
  });
  const all = $derived(["page-view", open ? "panel-open" : "", classes].filter(Boolean).join(" "));
</script>

<div class={all} bind:this={page}
  >{@render before?.()}<div class="page-grid"
    ><article class="doc" inert={modal}>{@render text()}</article
    >{#if modal}<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions --><div
        class="panel-scrim"
        aria-hidden="true"
        onclick={() => onScrim()}
      ></div>{/if}<div class="page-side" bind:this={sideBox}>{@render side()}</div></div
  ></div
>
