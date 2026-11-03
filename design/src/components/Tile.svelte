<script lang="ts">
  import type { TileProps } from "./types";

  /**
   * A library's tile (and the Tempra mark's shape): its letter on a dark square, a lighter round
   * one for a shared library where a row shows both. Decorative: the name beside it is the
   * caller's to draw. `size`: small in a row (the sidebar, a menu, the bell), large on a card.
   */
  let { letter, size = "default", shared = false }: TileProps = $props();
  const cls = $derived(
    ["lib-tile", size === "default" ? "" : size, shared ? "shared" : ""].filter(Boolean).join(" "),
  );
</script>

<span class={cls} aria-hidden="true">{letter}</span>
