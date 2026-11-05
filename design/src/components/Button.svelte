<script lang="ts">
  import type { ButtonProps } from "./types";

  /**
   * A pill button (base.css): outlined by default, `primary` the one solid action, `ghost` text.
   * With `href` it is a link drawn as a button (`a.button`: Show changes, Back to latest, Open,
   * Download; TEMPRA-288). Other attributes (a class, `aria-*`, `data-*`, `download`) go to the
   * element.
   */
  let {
    variant = "default",
    type = "button",
    href,
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

{#if href}<a {...rest} class={["button", cls]} {href} {onclick}>{@render children()}</a
  >{:else}<button {...rest} {type} class={cls} {disabled} {onclick}>{@render children()}</button>{/if}
