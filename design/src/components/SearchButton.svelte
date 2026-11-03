<script lang="ts">
  import Icon from "./Icon.svelte";
  import type { SearchButtonProps } from "./types";

  /** The round search button at the top bar's end (`.search-button`); `shortcut` is told in its title. */
  let { shortcut, onclick }: SearchButtonProps = $props();
</script>

<button
  type="button"
  class="icon-button search-button"
  aria-label="Search"
  aria-keyshortcuts="Control+K Meta+K"
  title={`Search (${shortcut})`}
  {onclick}><Icon name="search" /></button
>
