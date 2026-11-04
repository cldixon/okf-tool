<script lang="ts">
  import { day } from "../ui";
  import type { Urls } from "../urls";
  import type { Namer } from "./byline";
  import { checker } from "./checked";
  import type { Standing } from "./data";

  /**
   * The quiet line under the byline: "Checked by you, Oct 12", and "· changed since" (opening
   * review mode) when the page was edited after. Nothing when nobody has checked it.
   */
  let {
    urls,
    path,
    standing: s,
    name,
  }: { urls: Urls; path: string; standing: Standing; name: Namer } = $props();
  const who = $derived(checker(s, name));
</script>

{#if who && s.verified}
  <p class="doc-checked">Checked by {who}, {day(s.verified.event.ts)}{#if s.since > 0}<span class="byline-sep" aria-hidden="true">{" · "}</span><a href={urls.review(path)}>changed since</a>{/if}</p>
{/if}
