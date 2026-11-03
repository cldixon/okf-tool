<script lang="ts">
  import Icon from "./Icon.svelte";
  import type { CommentMarkProps } from "./types";

  /**
   * A block's open comments in the reader's gutter (`.comment-mark`): a glyph and the count, a
   * button that opens them. Other attributes (a class, an attachment that places it) go to it.
   */
  let { count, onclick, class: extra, ...rest }: CommentMarkProps = $props();
  const s = $derived(count === 1 ? "" : "s");
</script>

<button
  {...rest}
  type="button"
  class={["comment-mark", extra]}
  aria-label={`${count} comment${s}`}
  title={`${count} open comment${s}`}
  {onclick}><Icon name="comments" size={14} /><span>{count}</span></button
>
