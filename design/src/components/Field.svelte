<script lang="ts">
  import type { FieldProps } from "./types";

  /**
   * A labelled form field (`.field`): the label around its control (children), and a hint under
   * them. The hint sits outside the label, so it is not part of the control's name, and is the
   * control's description instead (`aria-describedby`, added to any it already has): a screen
   * reader says "Name, edit text, Optional. Your avatar's initials come from it."
   */
  let { label, hint, children }: FieldProps = $props();
  const uid = $props.id();
  const hintId = `${uid}-hint`;

  /** Names the hint as the description of the label's control (its input, select or textarea). */
  function describe(node: HTMLLabelElement) {
    if (!hint) return;
    const control = node.querySelector("input, select, textarea");
    if (!control) return;
    const own = control.getAttribute("aria-describedby");
    control.setAttribute("aria-describedby", own ? `${own} ${hintId}` : hintId);
    return () => {
      if (own) control.setAttribute("aria-describedby", own);
      else control.removeAttribute("aria-describedby");
    };
  }
</script>

<div class="field">
  <label {@attach describe}>{label}{@render children()}</label
  >{#if hint}<span id={hintId} class="field-hint">{hint}</span>{/if}
</div>
