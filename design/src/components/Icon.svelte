<script lang="ts">
  import { ICONS } from "./icons";
  import type { IconProps } from "./types";

  /** One of Lucide's glyphs at 16px with a 1.5 stroke, in the current text colour; decorative. */
  let { name, size = 16 }: IconProps = $props();
  const C = $derived(ICONS[name]);
</script>

<C {size} strokeWidth={1.5} aria-hidden="true" focusable="false" />
