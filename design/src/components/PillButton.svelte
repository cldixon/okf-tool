<script lang="ts">
  import Icon from "./Icon.svelte";
  import type { PillButtonProps } from "./types";

  /**
   * A pill with a glyph before its words (`.pill-button`: Back to page, New library): a link with
   * `href`, else a button. Other attributes (a class, `aria-*`, `download`) go to the element.
   */
  let { icon, label, href, onclick, class: extra, ...rest }: PillButtonProps = $props();
</script>

{#if href}<a {...rest} class={["button pill-button", extra]} {href} {onclick}
    >{#if icon}<Icon name={icon} />{/if}{label}</a
  >{:else}<button {...rest} type="button" class={["pill-button", extra]} {onclick}
    >{#if icon}<Icon name={icon} />{/if}{label}</button
  >{/if}
