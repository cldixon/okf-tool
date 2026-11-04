<script lang="ts">
  import { useAgentNames } from "../agents.svelte.ts";
  import type { Urls } from "../urls";
  import { changeLine, type Live } from "./live";

  /**
   * Someone else's change, said once in a polite live region (C-27, TEMPRA-133): "New version:
   * Claude Code for @dev changed this: the note." Kept mounted, so the words are announced when
   * they change; no time in them, so they do not change again as it passes.
   */
  let { urls, live }: { urls: Urls; live: Live | null } = $props();
  const names = useAgentNames(() => urls);
  const said = $derived.by(() => {
    const e = live?.change;
    if (!e) return "";
    const line = changeLine(e, names.label(e.actor, e.by), "")
      .replace(/ +\./, ".")
      .replace(/ +:/, ":");
    return e.op === "move" || e.op === "delete" ? line : `New version: ${line}`;
  });
</script>

<div class="visually-hidden" role="status" aria-live="polite">{said}</div>
