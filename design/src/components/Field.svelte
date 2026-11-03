<script lang="ts">
  import type { FieldProps } from "./types";

  /** A labelled form field (`.field`): the label, the control (children), a hint under it. */
  let { label, hint, children }: FieldProps = $props();
</script>

<label class="field"
  >{label}{@render children()}{#if hint}<span class="field-hint">{hint}</span>{/if}</label
>
