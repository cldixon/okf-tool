<script lang="ts">
  import { IconButton } from "@tempra/design/components";
  import { useCopy } from "./ui.svelte.ts";

  /** A value to copy (the MCP URL, a token's secret): the text in mono, a Copy button at its end. */
  let { value, label, id }: { value: string; label: string; id?: string } = $props();
  const copied = useCopy();
</script>

<span class="copy-field">
  <code {id}>{value}</code>
  <IconButton
    icon={copied.state === "copied" ? "check" : "copy"}
    label={`Copy ${label}`}
    title={copied.state === "copied" ? "Copied" : "Copy"}
    onclick={() => void copied.copy(value)}
  />
</span>
