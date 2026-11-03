<script lang="ts">
  import type { BadgeProps } from "./types";

  /**
   * A count on a control's corner (`.badge`; the bell's): nothing at 0, "99+" past 99. Decorative:
   * the control's name says the count.
   */
  let { count }: BadgeProps = $props();
</script>

{#if count > 0}<span class="badge" aria-hidden="true">{count > 99 ? "99+" : count}</span>{/if}
