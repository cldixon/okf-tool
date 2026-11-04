<script lang="ts">
  import { Chip } from "@tempra/design/components";

  /** What is exceptional about the page, as pills: a status that is not stable, and stale. */
  let { status, stale }: { status: string | null; stale: boolean } = $props();
  const shown = $derived.by(() => {
    const s = status?.trim();
    return s && s.toLowerCase() !== "stable" ? s : null;
  });
</script>

{#if shown || stale}<span class="byline-pills">{#if shown}<Chip>{shown.charAt(0).toUpperCase() + shown.slice(1)}</Chip>{/if}{#if stale}<Chip>Stale</Chip>{/if}</span>{/if}
