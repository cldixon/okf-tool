<script lang="ts">
  import { IconButton } from "@tempra/design/components";
  import { useCopy } from "./ui.svelte.ts";

  /**
   * A value to copy (the MCP URL, a token's secret): the text in mono, a Copy button at its end,
   * which keeps its glyph and says "Copied" in a tip for a moment, as Copy page does (TEMPRA-312).
   */
  let { value, label, id }: { value: string; label: string; id?: string } = $props();
  const copied = useCopy();
</script>

<span class="copy-field">
  <code {id}>{value}</code>
  <IconButton
    icon="copy"
    label={`Copy ${label}`}
    title="Copy"
    tip={copied.tip}
    onclick={() => void copied.copy(value)}
  />
</span>
