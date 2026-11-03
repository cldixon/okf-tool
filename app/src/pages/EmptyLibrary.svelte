<script lang="ts">
  import type { LedgerRequest } from "../activity";
  import { type ActorView, actorAgentName, actorText } from "../agents";
  import CopyField from "../CopyField.svelte";
  import Moment from "../Moment.svelte";
  import type { Role } from "../role";
  import { clip } from "../ui";
  import type { Urls } from "../urls";

  /**
   * A library with no pages (board 31): the steps to connect an agent, the MCP URL to copy, then
   * "Waiting for the first write" with the pulsing dot until an agent writes (the home reloads on
   * the feed, so it fills in live), and Import a bundle. By role (H-11): a read member, who can
   * neither connect an agent here nor import, sees only that nothing is here yet; Import is the
   * owner's (TEMPRA-124). `heading` names the box when it heads a library with pages but no agent.
   */
  let {
    urls,
    access: role,
    latest,
    who,
    heading,
  }: {
    urls: Urls;
    access: Role | null;
    latest: LedgerRequest | null;
    who: ActorView | null;
    heading?: string;
  } = $props();

  const mcp = `${typeof location === "undefined" ? "" : location.origin}/mcp`;
  const canWrite = $derived(role === "owner" || role === "write");
</script>

<section class="empty-library" aria-labelledby="empty-title">
  <h2 id="empty-title" class="view-section-title">{heading ?? "Nothing here yet"}</h2>
  {#if role === "read"}
    <p class="view-empty">Pages appear here when an agent writes them.</p>
  {/if}
  {#if canWrite}
    <ol class="empty-steps">
      <li>
        <span>Add Tempra to your agent:</span><CopyField value={mcp} label="the MCP URL" />
      </li>
      <li>
        <span>Ask it to start, for example: “In my {urls.slug} library, keep a page for each book I mention.”</span>
      </li>
    </ol>
  {/if}
  {#if canWrite || !heading}
    <p class="empty-wait" aria-live="polite">
      {#if latest}
        <span>Last write by {who ? actorText(who) : actorAgentName(latest.actor)}, <Moment ts={latest.ts} />{latest.note ? `: ${clip(latest.note, 80)}` : ""}</span>
      {:else}
        <span class="change-dot live" aria-hidden="true"></span><span>Waiting for the first write…</span>
      {/if}
    </p>
  {/if}
</section>
{#if canWrite}
  <p class="empty-more">{#if role === "owner"}<a href={urls.transfer()}>Import a bundle</a>{" · "}{/if}<a href={urls.connect()}>Other ways to connect</a></p>
{/if}
