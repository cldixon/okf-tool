<script lang="ts">
  import type { Snippet } from "svelte";
  import { useFrame } from "./frame.svelte.ts";
  import Portal from "./Portal.svelte";

  /**
   * A page's part of the top bar: its path (a page's folders and title, TEMPRA-145) and its
   * tools (a page's ⋯), drawn into the bar's slots from wherever the page is. On a phone the
   * bar names no page and no path: the page's own title does (TEMPRA-140).
   */
  let { path, actions }: { path?: Snippet; actions?: Snippet } = $props();
  const frame = useFrame();
</script>

{#if path && frame.slots.path}<Portal target={frame.slots.path}>{@render path()}</Portal>{/if}{#if actions && frame.slots.tools}<Portal target={frame.slots.tools}>{@render actions()}</Portal>{/if}
