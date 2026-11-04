<script lang="ts">
  import { dirOf, folderName } from "./urls";

  /**
   * A page's path in the top bar, as Linear's docs have it (TEMPRA-145): its folders, words and
   * not links (folders are not pages), then its title.
   */
  let props: { path: string; title: string } = $props();
  const folders = $derived.by(() => {
    const dir = dirOf(props.path);
    return dir ? dir.split("/").map((_, i, all) => all.slice(0, i + 1).join("/")) : [];
  });
</script>

<nav class="topbar-crumbs" aria-label="Path"
  >{#each folders as f (f)}<span class="crumb">{folderName(f)}</span>{/each}<span class="crumb" aria-current="page">{props.title}</span></nav
>
