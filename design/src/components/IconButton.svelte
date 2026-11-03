<script lang="ts">
  import Icon from "./Icon.svelte";
  import type { IconButtonProps } from "./types";

  /**
   * A round button holding one 16px glyph (`.icon-button`). `label` is its accessible name and,
   * unless `title` says otherwise, its tooltip; `pressed` makes it a toggle; `touch` gives it the
   * 44px area on a phone. Other attributes (a class, `aria-*`) go to the button.
   */
  let {
    icon,
    label,
    pressed,
    touch = false,
    onclick,
    title,
    class: extra,
    ...rest
  }: IconButtonProps = $props();
</script>

<button
  {...rest}
  type="button"
  class={["icon-button", touch && "touch", extra]}
  aria-label={label}
  aria-pressed={pressed}
  title={title ?? label}
  {onclick}><Icon name={icon} /></button
>
