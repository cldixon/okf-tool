<script lang="ts">
  import { actorText } from "../agents";
  import Moment from "../Moment.svelte";
  import type { Urls } from "../urls";
  import type { Namer } from "./byline";
  import { actedBy, type Concept, type Standing } from "./data";
  import { PAGE, versionHref } from "./history";

  /**
   * The History panel (take 4, TEMPRA-114; tempra-dev: app/reader, The panels): the concept's
   * versions, newest first (number, note, who and when). Each opens that version with what it
   * changed drawn in its text (`versionHref`). Verification is in Properties, not here
   * (decisions/verification-out-of-the-way).
   */
  let props: {
    urls: Urls;
    concept: Concept;
    standing: Standing;
    name: Namer;
    /** Whether the version on screen has its changes drawn (`?since=`). */
    comparing: boolean;
  } = $props();
  let shown = $state(PAGE);
  const versions = $derived([...props.standing.versions].reverse());
  const older = $derived(versions.length - shown);
</script>

<ol class="versions">
  {#each versions.slice(0, shown) as version (version.event.seq)}
    {@const e = version.event}
    {@const who = props.name(e.actor, actedBy(e))}
    {@const note = typeof e.meta?.note === "string" ? e.meta.note : ""}
    {@const onScreen = e.seq === props.standing.current?.event.seq}
    {@const chosen = onScreen && props.comparing}
    <li
      ><a
        class={chosen ? "version chosen" : onScreen ? "version current" : "version"}
        href={versionHref(props.urls, props.concept.path, props.standing.versions, version.n)}
        aria-current={onScreen ? "true" : undefined}
        title={version.n === 1 ? "The first version" : `What version ${version.n} changed`}
        ><span class="version-n">v{version.n}</span><span class="version-what"
          ><span class="version-note">{note || (version.n === 1 ? "Created" : "Edited")}</span><span class="version-who"
            >{actorText(who)} · <Moment ts={e.ts} /></span
          ></span
        ></a
      ></li
    >
  {/each}
</ol>{#if older > 0}<button type="button" class="ghost older-versions" onclick={() => (shown += PAGE)}>{older} older version{older === 1 ? "" : "s"}</button>{/if}
