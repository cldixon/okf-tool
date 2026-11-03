<script lang="ts">
  import { Menu } from "@tempra/design/components";
  import Portal from "../src/Portal.svelte";

  /** A Menu with three choices, and a Portal into `target`, as pages use them. */
  let { target }: { target: HTMLElement } = $props();
</script>

<button type="button" id="before">Before</button>
<Menu name="Things">
  {#snippet label()}⋯{/snippet}
  <a class="menu-item" href="/a">A</a>
  <button type="button" class="menu-item">B</button>
  <button type="button" class="menu-item" data-stay>C</button>
</Menu>
<Portal {target}><span class="portaled">Here</span></Portal>
