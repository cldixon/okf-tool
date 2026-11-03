<script lang="ts">
  import Button from "./Button.svelte";
  import Icon from "./Icon.svelte";
  import IconButton from "./IconButton.svelte";
  import { modal } from "./modal";
  import Notice from "./Notice.svelte";
  import type { ComposeDialogProps } from "./types";

  /**
   * A dialog that makes something (a new library): anchored high over the page, its context and
   * what it makes at the top ("@ann › New library"), then the form's own fields (a large
   * borderless name, a description; `.compose-title`, `.compose-text`), a row of smaller
   * fields, and the action at the foot. Ctrl/Cmd+Enter submits; Escape, × or a click beside it
   * cancels.
   */
  let props: ComposeDialogProps = $props();
  const titleId = $props.id();
</script>

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
<dialog
  {@attach modal(() => props.open)}
  class="dialog compose"
  aria-labelledby={titleId}
  onclose={() => props.onClose()}
  onclick={(e) => {
    if (e.target === e.currentTarget) props.onClose();
  }}
>
  {#if props.open}
    <form
      class="compose-form"
      onsubmit={(e) => props.onSubmit(e)}
      onkeydown={(e) => {
        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          e.currentTarget.requestSubmit();
        }
      }}
    >
      <div class="compose-head">
        <span class="compose-context">{@render props.context()}</span>
        <Icon name="chevron" />
        <h2 id={titleId}>{props.title}</h2>
        <IconButton icon="close" label="Close" touch onclick={() => props.onClose()} />
      </div>
      <div class="compose-body">{@render props.children()}</div>
      {#if props.fields}<div class="compose-fields">{@render props.fields()}</div>{/if}
      {#if props.error}<Notice>{props.error}</Notice>{/if}
      <div class="compose-foot">
        <Button variant="ghost" onclick={() => props.onClose()}>Cancel</Button>
        <Button variant="primary" type="submit" disabled={props.busy}>{props.action}</Button>
      </div>
    </form>
  {/if}
</dialog>
