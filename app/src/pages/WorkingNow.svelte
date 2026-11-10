<script lang="ts">
  import AgentName from "../AgentName.svelte";
  import { type LiveWrite, writerKey } from "../activity";
  import type { ActedBy, ActorView } from "../agents";
  import type { Urls } from "../urls";

  /**
   * Working now (Activity by page, Option B, TEMPRA-308): every agent writing now, one line each
   * with the pulsing dot, "Claude Code for @dev is editing Retention cohorts". A polite live
   * region, so a screen reader hears an agent start; nothing is drawn while nobody writes.
   */
  let {
    urls,
    working,
    view,
    titleOf,
  }: {
    urls: Urls;
    working: LiveWrite[];
    view(actor: string, by: ActedBy | null): ActorView;
    titleOf(path: string): string;
  } = $props();
</script>

<div class="activity-working" aria-live="polite">
  {#if working.length > 0}
    <h2 class="activity-working-title">Working now</h2>
    <ul class="activity-working-list">
      {#each working as w (writerKey(w))}
        <li><span class="change-dot live" aria-hidden="true"></span><span><AgentName who={view(w.actor, w.by)} /> is editing <a href={urls.file(w.path)}>{titleOf(w.path)}</a></span></li>
      {/each}
    </ul>
  {/if}
</div>
