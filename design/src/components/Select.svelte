<script lang="ts" generics="V extends string">
  import type { SelectProps } from "./types";

  /**
   * One choice from a list (TEMPRA-288): a native `<select>`, so it works by keyboard, by screen
   * reader and with a phone's own picker; `pill` (the default) is the outlined pill of a filter
   * row (`.pill-select`), `plain` the field look of a form. `options` may hold groups. `value`
   * binds; `onchange` hears a choice with its event, and a consumer that puts the select back
   * (`e.currentTarget.value = …`, to confirm first) keeps the value it had.
   */
  let {
    options,
    value = $bindable(),
    label,
    variant = "pill",
    onchange,
    class: extra,
    ...rest
  }: SelectProps<V> = $props();
</script>

<select
  {...rest}
  class={[variant === "pill" && "pill-select", extra]}
  aria-label={label}
  {value}
  onchange={(e) => {
    const chosen = e.currentTarget.value as V;
    onchange?.(chosen, e);
    if (e.currentTarget.value === chosen) value = chosen;
  }}
  >{#each options as o, i (i)}{#if "group" in o}<optgroup label={o.group}
        >{#each o.options as c, j (j)}<option value={c.value}>{c.label}</option>{/each}</optgroup
      >{:else}<option value={o.value}>{o.label}</option>{/if}{/each}</select
>
