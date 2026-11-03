<script lang="ts" generics="V extends string">
  import type { SegmentedProps } from "./types";

  /**
   * One choice of a few, as buttons in one grey pill (`.segmented`), the chosen one pressed.
   * `value` binds; `onchange` hears a choice too (a page that moves the URL instead). The buttons
   * carry `data-stay`, so a choice inside a menu leaves it open.
   */
  let { options, value = $bindable(), label, onchange }: SegmentedProps<V> = $props();
</script>

<fieldset class="segmented"
  ><legend class="visually-hidden">{label}</legend>{#each options as o (o.value)}<button
      type="button"
      aria-pressed={value === o.value}
      data-stay
      onclick={() => {
        if (value === o.value) return;
        value = o.value;
        onchange?.(o.value);
      }}>{o.label}</button
    >{/each}</fieldset
>
