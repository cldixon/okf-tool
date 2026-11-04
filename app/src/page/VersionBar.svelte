<script lang="ts">
  import type { Urls } from "../urls";
  import type { Namer } from "./byline";
  import type { Concept, Standing } from "./data";
  import VersionWhat from "./VersionWhat.svelte";

  /**
   * An earlier version on screen with no changes drawn (`?at=` alone): "v3 as it was · note · who
   * · when", Changes in v3 (the diff from the version before) and Back to latest.
   */
  let {
    urls,
    concept: c,
    standing: s,
    name,
  }: { urls: Urls; concept: Concept; standing: Standing; name: Namer } = $props();
  const version = $derived(s.current);
  const before = $derived.by(() => {
    const i = version ? s.versions.indexOf(version) : -1;
    return i > 0 ? s.versions[i - 1] : undefined;
  });
  const page = $derived(version ? urls.pinned(version.event.seq).file(c.path) : "");
</script>

{#if version}
  <section class="review-bar" aria-label="Version"
    ><span class="review-what"><VersionWhat {version} {name} lead={`v${version.n} as it was`} /></span
    ><span class="review-actions"
      >{#if before}<a class="button" href={`${page}${page.includes("?") ? "&" : "?"}since=${before.event.seq}`}>Changes in v{version.n}</a>{/if}<a
        class="button"
        href={urls.pinned(undefined).file(c.path)}>Back to latest</a
      ></span
    ></section
  >
{/if}
