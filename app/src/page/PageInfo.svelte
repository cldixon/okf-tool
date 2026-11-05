<script lang="ts">
  import { useAgentNames } from "../agents.svelte.ts";
  import { day } from "../ui";
  import type { Urls } from "../urls";
  import type { Namer } from "./byline";
  import { changesSince, checker } from "./checked";
  import { useCheck } from "./checked.svelte.ts";
  import type { Links, PageFile, Standing } from "./data";
  import HistoryList from "./HistoryList.svelte";
  import type { Live } from "./live";
  import PropertiesList from "./PropertiesList.svelte";
  import type { ReadHistory } from "./reads";

  /**
   * Page info (TEMPRA-283; tempra-dev: app/reader, The panels): what History and Properties held,
   * in one card. On top, what there is to do now: a newer version (Show it), and the check (the
   * changes since someone checked, with Show changes into review mode; Mark as checked on a page
   * nobody checked, for a write member; or a quiet line saying who checked it). Then About this
   * page (the facts) and Versions.
   */
  let props: {
    urls: Urls;
    page: PageFile;
    links: Links;
    head: number;
    standing: Standing;
    reads: ReadHistory | null;
    name: Namer;
    /** The latest version is on screen (checking is of the latest only). */
    current: boolean;
    /** Review mode is on: its bar has Mark as checked and Done. */
    reviewing: boolean;
    /** A version's changes are drawn (`?since=`). */
    comparing: boolean;
    /** A write member: may mark the page as checked. */
    mayVerify: boolean;
    /** Someone else's newer version, if one waits (and is not a move or a delete). */
    live: Live | null;
    onVerified(): void;
  } = $props();

  const names = useAgentNames(() => props.urls);
  const s = $derived(props.standing);
  const who = $derived(checker(s, props.name));
  const check = useCheck(
    () => props.urls,
    () => props.page.path,
    () => props.onVerified(),
  );
  const newerBy = $derived(
    props.live ? names.label(props.live.change.actor, props.live.change.by) : null,
  );
  const newerNote = $derived(props.live?.change.note ?? "");
  /** The check line has something to say: changes since, who checked, or Mark as checked. */
  const checkSays = $derived(
    props.current &&
      ((s.verified && (s.since > 0 || !!who)) ||
        (!s.verified && props.mayVerify && !props.reviewing) ||
        !!check.error),
  );
</script>

{#if props.live || checkSays}<ul class="page-info-now">
    {#if props.live}<li class="page-info-newer"
        ><span class="agent-dot" aria-hidden="true"></span><span class="grow" title={newerNote || undefined}>A newer version{newerBy ? ` by ${newerBy}` : ""}</span><button
          type="button"
          onclick={() => props.live?.onSwap()}>Show it</button
        ></li
      >{/if}{#if props.current}{#if s.verified && s.since > 0}<li class="page-info-check"
          ><span class="grow">{changesSince(s, props.name)}</span>{#if !props.reviewing}<a class="button" href={props.urls.review(props.page.path)}>Show changes</a>{/if}</li
        >{:else if s.verified && who}<li class="page-info-check muted">Checked by {who}, {day(s.verified.event.ts)}</li
        >{:else if !s.verified && props.mayVerify && !props.reviewing}<li class="page-info-check"
          ><span class="grow muted">Nobody has checked this page</span><button type="button" disabled={check.busy} onclick={() => check.check()}>Mark as checked</button></li
        >{/if}{#if check.error}<li class="small warn">{check.error}</li>{/if}{/if}
  </ul>{/if}<section class="page-info-section" aria-labelledby="page-info-about"
  ><h3 id="page-info-about">About this page</h3
  ><PropertiesList urls={props.urls} page={props.page} links={props.links} head={props.head} standing={s} reads={props.reads} name={props.name} /></section
><section class="page-info-section" aria-labelledby="page-info-versions"
  ><h3 id="page-info-versions">Versions</h3
  ><HistoryList urls={props.urls} page={props.page} standing={s} name={props.name} comparing={props.comparing} /></section
>
