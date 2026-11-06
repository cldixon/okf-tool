<script lang="ts">
  import { Button, Disclosure } from "@tempra/design/components";
  import { untrack } from "svelte";
  import { actorText } from "../agents";
  import Moment from "../Moment.svelte";
  import type { Urls } from "../urls";
  import type { Namer } from "./byline";
  import { actedBy, type PageFile, type Standing, type Version } from "./data";
  import { PAGE, versionHref } from "./history";

  /**
   * Page info's Current version (TEMPRA-309; tempra-dev: app/reader, The panels): the latest
   * version alone (number, its whole note up to three lines, who and when), then Earlier versions
   * (n), a disclosure listing the rest newest first, ten at a time with "n older versions". Each
   * row opens that version with what it changed drawn in its text (`versionHref`). The disclosure
   * starts closed and is never remembered, except that it starts open when an earlier version is
   * on screen, so that row shows marked. A page with one version has no disclosure.
   */
  let props: {
    urls: Urls;
    page: PageFile;
    standing: Standing;
    name: Namer;
    /** Whether the version on screen has its changes drawn (`?since=`). */
    comparing: boolean;
  } = $props();
  let shown = $state(PAGE);
  const versions = $derived([...props.standing.versions].reverse());
  const latest = $derived(versions[0]);
  const earlier = $derived(versions.slice(1));
  const older = $derived(earlier.length - shown);
  let open = $state(
    untrack(() => {
      const on = props.standing.current?.event.seq;
      const last = props.standing.versions.at(-1)?.event.seq;
      return on !== undefined && last !== undefined && on !== last;
    }),
  );
</script>

{#snippet row(version: Version)}
  {@const e = version.event}
  {@const who = props.name(e.actor, actedBy(e))}
  {@const note = typeof e.meta?.note === "string" ? e.meta.note : ""}
  {@const onScreen = e.seq === props.standing.current?.event.seq}
  {@const chosen = onScreen && props.comparing}
  <li
    ><a
      class={chosen ? "version chosen" : onScreen ? "version current" : "version"}
      href={versionHref(props.urls, props.page.path, props.standing.versions, version.n)}
      aria-current={onScreen ? "true" : undefined}
      title={version.n === 1 ? "The first version" : `What version ${version.n} changed`}
      ><span class="version-n">v{version.n}</span><span class="version-what"
        ><span class="version-note">{note || (version.n === 1 ? "Created" : "Edited")}</span><span class="version-who"
          >{actorText(who)} · <Moment ts={e.ts} /></span
        ></span
      ></a
    ></li
  >
{/snippet}

{#if latest}<ol class="versions latest-version">{@render row(latest)}</ol>{/if}{#if earlier.length > 0}<Disclosure
    class="earlier-toggle"
    label="Earlier versions"
    count={earlier.length}
    controls={open ? "page-info-earlier" : undefined}
    bind:open
  />{#if open}<div id="page-info-earlier" class="earlier-versions"
      ><ol class="versions">
        {#each earlier.slice(0, shown) as version (version.event.seq)}{@render row(version)}{/each}
      </ol>{#if older > 0}<Button variant="ghost" class="older-versions" onclick={() => (shown += PAGE)}
          >{older} older version{older === 1 ? "" : "s"}</Button
        >{/if}</div
    >{/if}{/if}
