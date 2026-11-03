<script lang="ts">
  import { Icon } from "@tempra/design/components";
  import { untrack } from "svelte";
  import { KINDS } from "../activity";

  /** Every event's own filters: the kind, and text to find in the path or the note. */
  let {
    kind,
    q,
    onChange,
  }: { kind: string; q: string; onChange(change: { kind?: string; q?: string }): void } = $props();

  let text = $state(untrack(() => q));
  // The URL's text wins when it changes (back and forward, a link).
  $effect.pre(() => {
    text = q;
  });
  // The text goes to the URL a moment after typing stops, or at once on Enter.
  $effect(() => {
    const t = text.trim();
    if (t === q) return;
    const timer = setTimeout(() => onChange({ q: t || undefined }), 300);
    return () => clearTimeout(timer);
  });

  function submit(e: SubmitEvent) {
    e.preventDefault();
    onChange({ q: text.trim() || undefined });
  }
</script>

<select
  class="pill-select"
  aria-label="Kind"
  value={kind}
  onchange={(e) => onChange({ kind: e.currentTarget.value || undefined })}
>
  <option value="">Any kind</option>
  {#each KINDS as k (k)}
    <option value={k}>{k}</option>
  {/each}
</select>
<form class="activity-find" onsubmit={submit}>
  <Icon name="search" />
  <input
    type="search"
    aria-label="Filter by path or note"
    placeholder="Filter by path or note"
    bind:value={text}
  />
</form>
