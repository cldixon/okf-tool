<script lang="ts">
  /**
   * A page body drawn from its stored tree (tempra-dev: app/reader): what body.ts works out,
   * drawn by Blocks.svelte. `hideFirst` keeps a leading heading that repeats the title in the DOM,
   * hidden, so offsets stay where the text has them.
   */
  import type { WordDiff } from "@tempra/editor";
  import Blocks from "./Blocks.svelte";
  import { bodyBlocks } from "./body";
  import type { Prepared } from "./prepare";
  import { node } from "./registry";

  let {
    prepared,
    diff,
    hideFirst,
  }: { prepared: Prepared; diff: WordDiff | null; hideFirst: boolean } = $props();
  const blocks = $derived(bodyBlocks(prepared, diff, hideFirst, (type) => type in node));
</script>

<Blocks {blocks} />
