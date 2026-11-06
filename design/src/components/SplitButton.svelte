<script lang="ts">
  import ButtonTip from "./ButtonTip.svelte";
  import Icon from "./Icon.svelte";
  import Menu from "./Menu.svelte";
  import type { SplitButtonProps } from "./types";

  /**
   * A main action with a ⌄ beside it for the related ones (TEMPRA-283: a page's Copy page, then
   * View Markdown and Download .md), in one outlined pill split by a hairline (`.split-button`).
   * Each part is a button of its own with its own name; the ⌄ is the design system's `Menu`.
   * `tip` (TEMPRA-312) says what the main part did, "Copied", for a moment under the pill and in a
   * polite live region, and names the main part while it shows; the glyph never changes for it.
   */
  let {
    icon,
    label,
    onclick,
    menuLabel,
    touch = false,
    tip,
    children: items,
    class: extra,
    ...rest
  }: SplitButtonProps = $props();
  let pill: HTMLDivElement | undefined = $state();
</script>

<div {...rest} bind:this={pill} class={["split-button", touch && "touch", extra]}
  ><button type="button" class="split-main" aria-label={tip || label} title={label} {onclick}><Icon name={icon} /></button
  ><span class="split-rule" aria-hidden="true"></span
  ><Menu name={menuLabel} title={menuLabel} buttonClass="split-more" align="end"
    >{#snippet label()}<Icon name="down" size={14} />{/snippet}{#snippet children(close)}{@render items(close)}{/snippet}</Menu
  >{#if tip !== undefined}<ButtonTip text={tip} anchor={pill} />{/if}</div
>
