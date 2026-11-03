<script lang="ts">
  import type { ToolPillProps } from "./types";

  /**
   * A control in the top bar that reads as a pill (`.tool-pill`): a link with `href`, else a
   * button. Other attributes go to the element.
   */
  let { label, href, onclick, class: extra, ...rest }: ToolPillProps = $props();
</script>

{#if href}<a {...rest} class={["tool-pill", extra]} {href} {onclick}>{label}</a
  >{:else}<button {...rest} type="button" class={["tool-pill", extra]} {onclick}>{label}</button>{/if}
