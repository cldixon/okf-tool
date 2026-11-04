<script lang="ts">
  import { Icon, Menu } from "@tempra/design/components";
  import { useAgentNames } from "../agents.svelte.ts";
  import { relativeTime } from "../ui";
  import { useNow } from "../ui.svelte.ts";
  import type { Urls } from "../urls";
  import { CONTENT_OPS } from "./data";
  import { changeLine, type Live } from "./live";

  /**
   * Someone else's change to the open file, in one of two places. In the cluster (`notice` off):
   * a newer version as a pulsing glyph that opens who wrote it, Show diff and Show new version.
   * As a notice on the page (`notice`): a change the cluster cannot show, the open file moved or
   * deleted (or not a page), with the way to where it went.
   */
  let { urls, live, notice = false }: { urls: Urls; live: Live; notice?: boolean } = $props();
  const names = useAgentNames(() => urls);
  const now = useNow(5000);
  const e = $derived(live.change);
  const by = $derived(names.label(e.actor, e.by));
  const line = $derived(changeLine(e, by, relativeTime(e.ts, now.current)));
</script>

{#if notice}
  <div class="notice">{line}{" "}{#if e.op === "move"}<a href={urls.pinned(undefined).file(e.path)}>Open it where it is now</a>{:else if e.op === "delete"}<a href={urls.tree("")}>Home</a>{:else}{#if CONTENT_OPS.has(e.op)}<a href={urls.diff(e.path, live.shownSeq, e.seq)}>Show diff</a>{" · "}{/if}<button type="button" onclick={() => live.onSwap()}>Show new version</button>{/if}</div>
{:else}
  <div class="new-version">
    <Menu name="New version" title={`New version · ${by}${e.note ? ` · ${e.note}` : ""}`} buttonClass="icon-button" align="end">
      {#snippet label()}<Icon name="refresh" />{/snippet}<p>{line}</p>{#if CONTENT_OPS.has(e.op)}<a href={urls.diff(e.path, live.shownSeq, e.seq)}>Show diff</a>{/if}<button type="button" onclick={() => live.onSwap()}>Show new version</button>
    </Menu>
  </div>
{/if}
