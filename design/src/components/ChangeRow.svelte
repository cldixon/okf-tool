<script lang="ts">
  import type { ChangeRowProps } from "./types";

  /**
   * Who changed what, and when (TEMPRA-288): one row of Activity's Summary, the home's Recently
   * changed and the live entry (`.change-row`). The lead (an avatar) at the left, the line and its
   * detail (a note, the pages touched, where and by whom) in the middle, the time at the right.
   * `continued` is a further row of the same person's run: no lead and no rule above it, so a run
   * of changes reads as one block. `live` is an agent writing now (the time row's pulsing dot).
   * With no lead at all it is `bare`: no avatar column, the line at the row's start (Activity by
   * page, TEMPRA-308, where the line is a page and its detail says who).
   */
  let {
    lead,
    children,
    detail,
    when,
    continued = false,
    live = false,
    class: extra,
    ...rest
  }: ChangeRowProps = $props();
</script>

<article
  {...rest}
  class={["change-row", continued && "continued", live && "live", !lead && "bare", extra]}
  >{#if lead}<span class="change-row-lead">{#if !continued}{@render lead()}{/if}</span>{/if}<div class="change-row-body"
    ><p class="change-row-line">{@render children()}</p
    >{#if detail}{@render detail()}{/if}</div
  >{#if when}<span class="change-row-when">{@render when()}</span>{/if}</article
>
