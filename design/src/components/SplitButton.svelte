<script lang="ts">
  import Icon from "./Icon.svelte";
  import Menu from "./Menu.svelte";
  import type { SplitButtonProps } from "./types";

  /**
   * A main action with a ⌄ beside it for the related ones (TEMPRA-283: a page's Copy page, then
   * View Markdown and Download .md), in one outlined pill split by a hairline (`.split-button`).
   * Each part is a button of its own with its own name; the ⌄ is the design system's `Menu`.
   */
  let {
    icon,
    label,
    onclick,
    menuLabel,
    touch = false,
    children: items,
    class: extra,
    ...rest
  }: SplitButtonProps = $props();
</script>

<div {...rest} class={["split-button", touch && "touch", extra]}
  ><button type="button" class="split-main" aria-label={label} title={label} {onclick}><Icon name={icon} /></button
  ><span class="split-rule" aria-hidden="true"></span
  ><Menu name={menuLabel} title={menuLabel} buttonClass="split-more" align="end"
    >{#snippet label()}<Icon name="down" size={14} />{/snippet}{#snippet children(close)}{@render items(close)}{/snippet}</Menu
  ></div
>
