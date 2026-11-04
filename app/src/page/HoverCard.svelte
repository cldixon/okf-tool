<script lang="ts">
  import Note from "../reader/Note.svelte";
  import type { Card } from "./hover";

  /** A card over the body, as `hover` described it (concept/hover.ts). */
  let { card }: { card: Card } = $props();
</script>

{#if card.kind === "note"}
  <div class="small"><Note prepared={card.prepared} nodes={card.nodes} /></div>
{:else if card.kind === "source"}
  <div><strong>{card.title}</strong>{#if card.resource}<div class="small muted">{card.resource}</div>{/if}{#if card.broken}<div class="small">Missing</div>{/if}{#if card.stale}<div class="small">Stale</div>{/if}</div>
{:else if card.kind === "text"}
  <div class="small">{card.text}</div>
{:else}
  <div><strong>{card.title}</strong>{#if card.facts}<div class="small muted">{card.facts}</div>{/if}{#if card.description}<div class="small">{card.description}</div>{/if}</div>
{/if}
