<script lang="ts">
  import type { Snippet } from "svelte";

  /**
   * A page's column in the frame (everything but a page, which lays out its own columns);
   * `inert` while a panel over it is modal (the home's Comments, TEMPRA-222).
   */
  let {
    children,
    wide = false,
    inert = false,
  }: { children: Snippet; wide?: boolean; inert?: boolean } = $props();
</script>

<div class={wide ? "page-column wide" : "page-column"} inert={inert || undefined}>{@render children()}</div>
