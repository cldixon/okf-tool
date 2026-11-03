<script lang="ts">
  import IconButton from "./IconButton.svelte";
  import { modal } from "./modal";
  import type { DialogProps } from "./types";

  /**
   * A small modal dialog in the top layer: a title, a close button, its content. Escape, the
   * close button or a click on the backdrop closes it, and the focus goes back where it was.
   */
  let props: DialogProps = $props();
  const titleId = $props.id();
</script>

<!-- A click on the backdrop lands on the dialog itself, outside its content: it closes. -->
<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
<dialog
  {@attach modal(() => props.open)}
  class={props.wide ? "dialog wide" : "dialog"}
  aria-labelledby={titleId}
  onclose={() => props.onClose()}
  onclick={(e) => {
    if (e.target === e.currentTarget) props.onClose();
  }}
>
  {#if props.open}
    <div class="dialog-box">
      <div class="dialog-head">
        <h2 id={titleId}>{props.title}</h2>
        <IconButton icon="close" label="Close" touch onclick={() => props.onClose()} />
      </div>
      <div class="dialog-body">{@render props.children()}</div>
    </div>
  {/if}
</dialog>
