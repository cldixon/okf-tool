<script lang="ts">
  import Icon from "./Icon.svelte";
  import type { SearchFieldProps } from "./types";

  /** A search box with its glyph inside (`.search-field`, base.css). `label` names it. */
  let { value = $bindable(""), placeholder, label, ...rest }: SearchFieldProps = $props();
</script>

<span class="search-field"
  ><Icon name="search" /><input {...rest} type="search" aria-label={label} {placeholder} bind:value /></span
>
