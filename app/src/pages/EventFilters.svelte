<script lang="ts">
  import { SearchField, Select } from "@tempra/design/components";
  import { untrack } from "svelte";
  import { KINDS } from "../activity";

  /**
   * Every event's own filters: the kind, and text to find in the path or the note, from the design
   * system's Select and SearchField (TEMPRA-288).
   */
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
  const kinds = [{ value: "", label: "Any kind" }, ...KINDS.map((k) => ({ value: k, label: k }))];
</script>

<Select label="Kind" value={kind} options={kinds} onchange={(v) => onChange({ kind: v || undefined })} />
<form class="activity-find" onsubmit={submit}>
  <SearchField label="Filter by path or note" placeholder="Filter by path or note" bind:value={text} />
</form>
