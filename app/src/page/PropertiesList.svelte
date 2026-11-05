<script lang="ts">
  import AgentName from "../AgentName.svelte";
  import { useTitleOf } from "../frame.svelte.ts";
  import Moment from "../Moment.svelte";
  import { day, plural } from "../ui";
  import type { Urls } from "../urls";
  import type { Namer } from "./byline";
  import { actedBy, type Json, type Links, type PageFile, type Standing } from "./data";
  import { type ReadHistory, readWords } from "./reads";

  /**
   * About this page, in Page info (TEMPRA-283; Properties' facts before, TEMPRA-114, 122 and 134;
   * tempra-dev: app/reader, The panels): short and in people's words. What a reader needs
   * (status, stale or not, who changed it last, tags, reads, sources, what links here by title).
   * The check is Page info's top line now. What agents would fix (lint, work items, broken links)
   * is theirs, through `work`, not the panel's (TEMPRA-144).
   */
  let props: {
    urls: Urls;
    page: PageFile;
    links: Links;
    head: number;
    standing: Standing;
    /** How much it is read and how recently (TEMPRA-220): counts only, never who. */
    reads: ReadHistory | null;
    name: Namer;
  } = $props();

  /** A frontmatter value as text: a list joined, anything else as it reads. */
  function text(v: Json | undefined): string | null {
    if (v === undefined || v === null || v === "") return null;
    if (Array.isArray(v)) {
      const words = v.filter((x) => x !== null && typeof x !== "object").map(String);
      return words.length > 0 ? words.join(", ") : null;
    }
    return typeof v === "object" ? null : String(v);
  }

  /** "No, until Nov 19", "Soon, on Nov 2", "Yes, since Oct 3", or "No". */
  function staleWords(c: PageFile): string {
    const after = text(c.frontmatter.stale_after);
    const on = after ? day(after) : null;
    if (c.stale) return on ? `Yes, since ${on}` : "Yes";
    if (c.stale_soon && on) return `Soon, on ${on}`;
    return on ? `No, until ${on}` : "No";
  }

  // What a reader asks about the page, in a fixed order.
  const fm = $derived(props.page.frontmatter);
  const sources = $derived(Array.isArray(fm.sources) ? fm.sources.length : 0);
  const last = $derived(props.standing.current?.event);
  const status = $derived(text(fm.status));
  const tags = $derived(text(fm.tags));

  // What links here, by title: one row per page, however many times it links here.
  const atHead = $derived(props.urls.at === undefined || props.urls.at >= props.head);
  const titles = useTitleOf();
  const pages = $derived([...new Map(props.links.inbound.map((l) => [l.path, l])).values()]);
</script>

{#snippet notSet()}<span class="muted">not set</span>{/snippet}
<dl class="facts"
  ><div class="fact"><dt>Status</dt><dd>{#if status !== null}{status}{:else}{@render notSet()}{/if}</dd></div
  ><div class="fact"><dt>Stale</dt><dd>{staleWords(props.page)}</dd></div
  >{#if last}<div class="fact"
      ><dt>Last changed</dt><dd><span><AgentName who={props.name(last.actor, actedBy(last))} />, <Moment ts={last.ts} /></span></dd></div
    >{/if}{#if tags}<div class="fact"><dt>Tags</dt><dd>{tags}</dd></div>{/if}{#if props.reads}<div class="fact"
      ><dt>Read</dt><dd>{readWords(props.reads)}</dd></div
    ><div class="fact"
      ><dt>Last read</dt><dd>{#if props.reads.last_read}<Moment ts={props.reads.last_read} />{:else}<span class="muted">not yet</span>{/if}</dd></div
    >{/if}<div class="fact"
    ><dt>Sources</dt><dd>{#if sources > 0}<a href="#doc-sources">{plural(sources, "source")}</a>{:else}None{/if}</dd></div
  ></dl
><section class="panel-section"
  ><h3 class="label">Linked from</h3
  >{#if pages.length > 0}<ul class="linked">
      {#each pages as l (l.path)}<li><a href={props.urls.pinned(undefined).file(l.path)}>{titles.of(l.path)}</a>{#if l.kind === "source"}<span class="muted">{" cites it"}</span>{/if}</li>{/each}
    </ul>{:else}<p class="small muted">{atHead ? "Nothing links here." : "Shown for the latest version."}</p>{/if}</section
>
