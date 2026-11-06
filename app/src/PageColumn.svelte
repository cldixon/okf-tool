<script lang="ts">
  import type { Snippet } from "svelte";

  /**
   * A page's column in the frame (everything but a page and the library's home, which lay out
   * their own columns: page/PageFrame.svelte).
   */
  let { children, wide = false }: { children: Snippet; wide?: boolean } = $props();
</script>

<div class={wide ? "page-column wide" : "page-column"}>{@render children()}</div>
