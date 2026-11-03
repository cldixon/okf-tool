<script lang="ts">
  import { Icon, Menu, Tile } from "@tempra/design/components";
  import { isShared, libraryLabel, type ReachableLibrary } from "./role";
  import { useLibraries } from "./role.svelte.ts";
  import { byKind } from "./sidebar";
  import { tileLetter } from "./ui";
  import { Urls } from "./urls";

  /**
   * The library switcher (take 4, board 07; TEMPRA-145): ⌄ beside the library's name in the bar;
   * its menu only switches: the person's libraries (Yours, then Shared with you with their role,
   * this one ticked), then All libraries and New library. The library's settings are the
   * sidebar's foot's.
   */
  let { urls, name }: { urls: Urls; name: string } = $props();
  const libs = useLibraries();
  const kinds = $derived(byKind(libs.data?.libraries ?? []));
  const here = (l: ReachableLibrary) => l.owner === urls.owner && l.slug === urls.slug;
</script>

{#snippet row(l: ReachableLibrary)}<a
    class="menu-lib"
    href={new Urls(l.owner, l.slug).tree("")}
    aria-current={here(l) ? "page" : undefined}
    ><Tile letter={tileLetter(l.title || l.slug)} size="small" shared={isShared(l)} /><span
      >{libraryLabel(l)}</span
    >{#if isShared(l)}<span class="menu-lib-role"
        >{l.role === "write" ? "Write" : "Read"}</span
      >{/if}{#if here(l)}<span class="menu-lib-check"><Icon name="check" size={14} /></span>{/if}</a
  >{/snippet}
<Menu name="Switch library" title={`Switch from ${name}`} buttonClass="icon-button lib-switch" listClass="libraries">
  {#snippet label()}<Icon name="down" size={14} />{/snippet}
  {#if kinds.yours.length > 0}<div class="menu-note">Yours</div>{/if}
  {#each kinds.yours as l (`${l.owner}/${l.slug}`)}{@render row(l)}{/each}
  {#if kinds.shared.length > 0}<div class="menu-note">Shared with you</div>{/if}
  {#each kinds.shared as l (`${l.owner}/${l.slug}`)}{@render row(l)}{/each}
  <hr />
  <a class="menu-item" href="/"><Icon name="libraries" />All libraries</a>
  <a class="menu-item" href="/?new=1"><Icon name="plus" />New library</a>
</Menu>
