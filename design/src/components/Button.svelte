<script lang="ts">
  import type { ButtonProps } from "./types";

  /**
   * A pill button (base.css): outlined by default, `primary` the one solid action, `ghost` text.
   * Other attributes (a class, `aria-*`, `data-*`) go to the button.
   */
  let {
    variant = "default",
    type = "button",
    disabled = false,
    onclick,
    children,
    class: extra,
    ...rest
  }: ButtonProps = $props();
  const cls = $derived(
    [variant === "default" ? "" : variant, extra ?? ""].filter(Boolean).join(" ") || undefined,
  );
</script>

<button {...rest} {type} class={cls} {disabled} {onclick}>{@render children()}</button>
