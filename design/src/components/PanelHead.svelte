<script lang="ts">
  import IconButton from "./IconButton.svelte";
  import type { PanelHeadProps } from "./types";

  /**
   * A panel's head (`.panel-head`): a drag handle (shown on a phone's sheet), the title (an h2
   * that takes the focus when the panel opens), a count where there is one, and ×. Other
   * attributes (the sheet's pointer handlers) go to the header.
   */
  let { title, count, onClose, ...rest }: PanelHeadProps = $props();
</script>

<header {...rest} class="panel-head"
  ><span class="panel-grip" aria-hidden="true"></span><h2 tabindex="-1">{title}</h2
  >{#if count !== undefined && count !== null && count !== ""}<span class="count">{count}</span
    >{/if}<IconButton icon="close" label={`Close ${title.toLowerCase()}`} title="Close" touch onclick={() => onClose()} /></header
>
