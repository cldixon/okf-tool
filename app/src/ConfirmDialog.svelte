<script lang="ts">
  import { Dialog } from "@tempra/design/components";
  import type { Confirming } from "./confirm.svelte.ts";

  let { asking }: { asking: Confirming } = $props();
  const ask = $derived(asking.ask);
</script>

<Dialog title={ask?.title ?? ""} open={ask !== null} onClose={() => asking.close()}>
  {#if ask}
    <div class="confirm-body">
      {#if typeof ask.body === "string"}{ask.body}{:else}{@render ask.body()}{/if}
    </div>
    <p class="actions">
      <button
        type="button"
        class="primary"
        onclick={() => {
          const run = ask.run;
          asking.close();
          run();
        }}>{ask.action}</button
      >
      <button type="button" onclick={() => asking.close()}>Cancel</button>
    </p>
  {/if}
</Dialog>
