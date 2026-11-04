<script lang="ts">
  import AgentName from "../AgentName.svelte";
  import { useTitleOf } from "../frame.svelte.ts";
  import Moment from "../Moment.svelte";
  import { day, plural } from "../ui";
  import type { Urls } from "../urls";
  import type { Namer } from "./byline";
  import { changesSince } from "./checked";
  import { useCheck } from "./checked.svelte.ts";
  import { actedBy, type Concept, type Json, type Links, type Standing } from "./data";
  import { type ReadHistory, readWords } from "./reads";

  /**
   * The Properties panel (take 4, TEMPRA-114; TEMPRA-122 and 134; tempra-dev: app/reader, The
   * panels): short and in people's words. What a reader needs (status, stale or not, who changed
   * it last, type, tags, sources, what links here by title), then Check when there is something to
   * do (decisions/take4-followups-ui-only). What agents would fix (lint, work items, broken links)
   * is theirs, through `work`, not the panel's (TEMPRA-144).
   */
  let props: {
    urls: Urls;
    concept: Concept;
    links: Links;
    head: number;
    standing: Standing;
    /** How much it is read and how recently (TEMPRA-220): counts only, never who. */
    reads: ReadHistory | null;
    name: Namer;
    /** The page is current (not a pinned old version), so it can be checked. */
    current: boolean;
    /** Review mode is on (the changes since the last check are drawn). */
    reviewing: boolean;
    /** A write member: may mark it as checked. */
    mayVerify: boolean;
    onVerified(): void;
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
  function staleWords(c: Concept): string {
    const after = text(c.frontmatter.stale_after);
    const on = after ? day(after) : null;
    if (c.stale) return on ? `Yes, since ${on}` : "Yes";
    if (c.stale_soon && on) return `Soon, on ${on}`;
    return on ? `No, until ${on}` : "No";
  }

  // What a reader asks about the page, in a fixed order.
  const fm = $derived(props.concept.frontmatter);
  const sources = $derived(Array.isArray(fm.sources) ? fm.sources.length : 0);
  const last = $derived(props.standing.current?.event);
  const status = $derived(text(fm.status));
  const type = $derived(text(fm.type));
  const tags = $derived(text(fm.tags));

  // What links here, by title: one row per page, however many times it links here.
  const atHead = $derived(props.urls.at === undefined || props.urls.at >= props.head);
  const titles = useTitleOf();
  const pages = $derived([...new Map(props.links.inbound.map((l) => [l.path, l])).values()]);

  /*
   * Whether a person checked the page, when there is something to do about it: a page nobody
   * checked offers only Mark as checked (to a write member); a page checked and changed since says
   * how much and offers Show changes (review mode, whose bar has Mark as checked and Done); nothing
   * once the version on screen is the checked one.
   */
  const s = $derived(props.standing);
  const showCheck = $derived(
    props.current &&
      !(s.verified && s.since === 0) &&
      !(!s.verified && (!props.mayVerify || props.reviewing)),
  );
  const check = useCheck(
    () => props.urls,
    () => props.concept.path,
    () => props.onVerified(),
  );
</script>

{#snippet notSet()}<span class="muted">not set</span>{/snippet}
<dl class="facts"
  ><div class="fact"><dt>Status</dt><dd>{#if status !== null}{status}{:else}{@render notSet()}{/if}</dd></div
  ><div class="fact"><dt>Stale</dt><dd>{staleWords(props.concept)}</dd></div
  >{#if last}<div class="fact"
      ><dt>Last changed</dt><dd><span><AgentName who={props.name(last.actor, actedBy(last))} />, <Moment ts={last.ts} /></span></dd></div
    >{/if}<div class="fact"><dt>Type</dt><dd>{#if type !== null}{type}{:else}{@render notSet()}{/if}</dd></div
  >{#if tags}<div class="fact"><dt>Tags</dt><dd>{tags}</dd></div>{/if}{#if props.reads}<div class="fact"
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
>{#if showCheck}<section class="panel-section check" aria-label="Check"
    >{#if s.verified}<p class="check-state">{changesSince(s, props.name)}</p
      ><!-- In review mode the bar over the text has Mark as checked and Done. -->{#if !props.reviewing}<div class="actions"><a class="button" href={props.urls.review(props.concept.path)}>Show changes</a></div>{/if}{:else}<div class="actions"><button type="button" disabled={check.busy} onclick={() => check.check()}>Mark as checked</button></div>{/if}{#if check.error}<p class="small warn">{check.error}</p>{/if}</section
  >{/if}
