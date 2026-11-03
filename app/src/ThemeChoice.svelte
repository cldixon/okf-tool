<script lang="ts">
  import { Segmented } from "@tempra/design/components";
  import { THEMES, type Theme } from "./theme.svelte.ts";

  /** System, Light, Dark as one segmented control (the avatar's menu, the Account page). */
  let { value, onChange }: { value: Theme; onChange(theme: Theme): void } = $props();
  const options = THEMES.map(([key, label]) => ({ value: key, label }));
</script>

<Segmented label="Theme" {options} {value} onchange={(v) => onChange(v as Theme)} />
