<script lang="ts">
  import type { TextInputProps } from "./types";

  /** A text input (base.css). `value` binds; other attributes (`aria-*`, `required`) go to it. */
  let {
    value = $bindable(""),
    placeholder,
    type = "text",
    name,
    disabled = false,
    ...rest
  }: TextInputProps = $props();
</script>

<input {...rest} {type} {name} {placeholder} {disabled} bind:value />
