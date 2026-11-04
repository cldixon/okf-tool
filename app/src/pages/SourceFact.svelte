<script lang="ts">
  import AgentName from "../AgentName.svelte";
  import Moment from "../Moment.svelte";
  import type { AttachSource, MadeFrom } from "../page/data";
  import { baseName, type Urls } from "../urls";
  import { hostOf, type Name, type Use, type Version } from "./attachment";

  /**
   * Source: "From example.com, fetched 2 hours ago" linking the URL (and where it was redirected
   * to), or "Uploaded by Claude Code for @dev" for bytes an agent sent, with ", file supplied by
   * @ann" when a person sent them from the agent's upload link (TEMPRA-196), or "Made by Claude
   * Code for @dev from photo.png" when an agent's `transform` made it (TEMPRA-208); then the page
   * that cites it, when one does.
   */
  let props: {
    urls: Urls;
    source: AttachSource | null | undefined;
    /** Who sent the bytes from an upload link, by handle. */
    suppliedBy?: string | null | undefined;
    /** What an agent made it from on the server (TEMPRA-208). */
    madeFrom?: MadeFrom | null | undefined;
    /** The version on screen, for who uploaded it. */
    version: Version | null;
    uses: readonly Use[] | null;
    titles: ReadonlyMap<string, string>;
    name: Name;
  } = $props();
  // A link to the web, its attributes in the order the page has always drawn them.
  const outbound = (href: string) => ({ href, rel: "noopener noreferrer", target: "_blank" });
  const cited = $derived((props.uses ?? []).find((u) => u.cites !== null));
  const redirected = $derived(
    props.source?.final_url && props.source.final_url !== props.source.url
      ? props.source.final_url
      : null,
  );
</script>

{#if props.madeFrom && props.version}<div
    >Made by <AgentName who={props.name(props.version.actor, props.version.by)} />{" from "}<a
      href={props.urls.file(props.madeFrom.path)}>{baseName(props.madeFrom.path)}</a
    ></div
  >{:else if props.source}<div
    >From <a {...outbound(props.source.url)}>{hostOf(props.source.url)}</a
    >{#if props.source.fetched_at}, fetched <Moment ts={props.source.fetched_at} />{/if}</div
  >{:else if props.version}<div>Uploaded by <AgentName who={props.name(props.version.actor, props.version.by)} />{#if props.suppliedBy}{`, file supplied by @${props.suppliedBy}`}{/if}</div
  >{:else}<div class="muted">…</div>{/if}{#if redirected}<div class="muted"
    >Redirected to <a {...outbound(redirected)}>{hostOf(redirected)}</a></div
  >{/if}{#if cited}<div class="muted"
    >Cited in <a href={props.urls.file(cited.path)}>{props.titles.get(cited.path) ?? baseName(cited.path)}</a> as “{cited.cites}”</div
  >{/if}
