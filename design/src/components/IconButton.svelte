<script lang="ts">
  import ButtonTip from "./ButtonTip.svelte";
  import Icon from "./Icon.svelte";
  import type { IconButtonProps } from "./types";

  /**
   * A round button holding one 16px glyph (`.icon-button`). `label` is its accessible name and,
   * unless `title` says otherwise, its tooltip; `pressed` makes it a toggle; `touch` gives it the
   * 44px area on a phone. `variant="outlined"` is a page's corner tool (TEMPRA-283): a ring at
   * 36px, with a `count` beside the glyph and the agent `dot` on its corner. Other attributes (a
   * class, `aria-*`) go to the button. `tip` (TEMPRA-312) says what a press did, "Copied", for a
   * moment under the button and in a polite live region, and names the button while it shows;
   * the glyph never changes for it.
   */
  let {
    icon,
    label,
    pressed,
    touch = false,
    variant = "plain",
    count = null,
    dot = false,
    onclick,
    title,
    tip,
    class: extra,
    ...rest
  }: IconButtonProps = $props();
  const hasCount = $derived(typeof count === "number" && count > 0);
  let button: HTMLButtonElement | undefined = $state();
</script>

<button
  {...rest}
  bind:this={button}
  type="button"
  class={[
    "icon-button",
    variant === "outlined" && "outlined",
    hasCount && "has-count",
    touch && "touch",
    extra,
  ]}
  aria-label={tip || label}
  aria-pressed={pressed}
  title={title ?? label}
  {onclick}
  ><Icon name={icon} />{#if hasCount}<span class="icon-button-count" aria-hidden="true">{count}</span
    >{/if}{#if dot}<span class="icon-button-dot" aria-hidden="true"></span>{/if}</button
>{#if tip !== undefined}<ButtonTip text={tip} anchor={button} />{/if}
