<script lang="ts">
  import type { ChipProps } from "./types";

  /** A grey pill for what is exceptional about something (`.chip`): Draft, Stale, revoked. */
  let { tone = "default", children }: ChipProps = $props();
</script>

<span class={tone === "default" ? "chip" : `chip ${tone}`}>{@render children()}</span>
