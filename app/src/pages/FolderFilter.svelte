<script lang="ts">
  import { Select } from "@tempra/design/components";
  import { folderOptions } from "../activity";
  import { useFrame } from "../frame.svelte.ts";

  /**
   * The folder (Activity by page, Option B, TEMPRA-308): All folders, or one of the library's
   * folders from the frame's index, nested ones as "App / Reader". The server filters by it
   * (`prefix`, in the URL); a folder in the URL that the index lacks is still offered.
   */
  let { prefix, onChange }: { prefix: string; onChange(prefix: string): void } = $props();

  const frame = useFrame();
  const options = $derived(folderOptions(frame.index ?? [], prefix));
</script>

<Select label="Folder" value={prefix} {options} onchange={(v) => onChange(v)} />
