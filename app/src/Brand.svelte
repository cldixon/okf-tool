<script lang="ts">
  import { Mark, SearchButton } from "@tempra/design/components";
  import LibrarySwitcher from "./LibrarySwitcher.svelte";
  import type { BrandLibrary } from "./Shell.svelte";
  import { switcherKey } from "./ui";

  /**
   * Over the sidebar (and at the phone's drawer's head), as Linear's docs have it (TEMPRA-145): the
   * Tempra mark (to the library list; TEMPRA-279), the library's name (to its home) with its
   * switcher, and search. Off a library, the mark and "Tempra". `short`: the phone's bar, the mark
   * and the name. The mark and the name share a baseline, the mark's front plate on the name's
   * cap line (`.mark-lockup`).
   */
  let props: { library?: BrandLibrary; onSearch?: () => void; short?: boolean } = $props();
</script>

<span class="brand-lockup mark-lockup"
  ><a class="brand-mark" href="/" aria-label="Tempra" title="Tempra"><Mark small /></a><span
    class="brand-sep"
    aria-hidden="true"
  ></span
  >{#if props.library}<a
      class="brand-name"
      href={props.library.urls.tree("")}
      aria-current={props.library.home ? "page" : undefined}>{props.library.name}</a
    >{:else}<a class="brand-name" href="/">Tempra</a>{/if}</span
>{#if props.library && !props.short}<LibrarySwitcher
    urls={props.library.urls}
    name={props.library.name}
  />{/if}{#if props.onSearch && !props.short}<SearchButton
    shortcut={switcherKey()}
    onclick={props.onSearch}
  />{/if}
