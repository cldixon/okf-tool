<script lang="ts">
  import Icon from "./Icon.svelte";
  import type { DisclosureProps } from "./types";

  /**
   * A quiet text button that shows and hides what follows it (`.disclosure`, TEMPRA-309): a
   * chevron that turns while open, the label, and a count beside it in the muted grey. `open`
   * binds and is told as `aria-expanded`; `controls` names the region it shows (`aria-controls`).
   * Other attributes (a class, `aria-*`) go to the button.
   */
  let {
    label,
    open = $bindable(false),
    count = null,
    controls,
    onchange,
    class: extra,
    ...rest
  }: DisclosureProps = $props();
  const hasCount = $derived(typeof count === "number" && count > 0);
</script>

<button
  {...rest}
  type="button"
  class={["disclosure", extra]}
  aria-expanded={open}
  aria-controls={controls}
  onclick={() => {
    open = !open;
    onchange?.(open);
  }}
  ><Icon name="chevron" /><span class="disclosure-label">{label}</span>{#if hasCount}{" "}<span class="disclosure-count"
      >{count}</span
    >{/if}</button
>
