<script lang="ts">
  import { Chip, Icon } from "@tempra/design/components";
  import AgentName from "../AgentName.svelte";
  import Moment from "../Moment.svelte";
  import { relativeTime } from "../ui";
  import { baseName, type Urls } from "../urls";
  import { type Name, sizeText, type Version } from "./attachment";

  /**
   * File history: every version newest first, who and when, its size and dimensions, Download for
   * each (the version's own bytes, `?at=`), the one on screen marked Current.
   */
  let props: { urls: Urls; path: string; versions: readonly Version[]; name: Name } = $props();
</script>

<section class="attachment-history" aria-labelledby="file-history"
  ><h2 id="file-history" class="view-section-title">File history</h2
  ><ol>
    {#each props.versions as v (v.seq)}<li class={v.current ? "current" : undefined}
        ><span class="attachment-version-when"><Moment ts={v.ts} />{#if v.current}<Chip>Current</Chip>{/if}</span
        ><span class="attachment-version-who">{v.what} by <AgentName who={props.name(v.actor, v.by)} /></span
        ><span class="attachment-version-size muted">{sizeText(v.size, v.width, v.height)}</span
        ><a class="attachment-version-download" href={props.urls.pinned(v.seq).download(props.path)} download={baseName(props.path)}
          ><Icon name="download" /> Download<span class="visually-hidden">{` the version from ${relativeTime(v.ts)}`}</span></a
        ></li
      >{/each}
  </ol></section
>
