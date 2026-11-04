<script lang="ts">
  import type { Entry } from "./contents";

  /**
   * The concept's contents (take 4; tempra-dev: app/reader, Contents): its top two heading levels,
   * nested, on the right of the page while no panel is open and there is room, otherwise under the
   * byline ("On this page"). The section in view is marked with a rule.
   */
  let { headings, onPick }: { headings: Entry[]; onPick?(): void } = $props();

  // The heading the page is scrolled to: the last one above the top of the view.
  let current = $state<string | null>(null);
  const ids = $derived(headings.map((h) => h.id).join(" "));
  $effect(() => {
    const scroller = document.querySelector(".ws-main");
    if (!scroller || !ids) return;
    const list = ids.split(" ");
    const update = () => {
      const top = scroller.getBoundingClientRect().top + 120;
      let at: string | null = list[0] ?? null;
      for (const id of list) {
        const el = document.getElementById(id);
        if (el && el.getBoundingClientRect().top <= top) at = id;
      }
      current = at;
    };
    // Measured after the first paint: reading layout while the page mounts would hold it back.
    const first = requestAnimationFrame(update);
    scroller.addEventListener("scroll", update, { passive: true });
    return () => {
      cancelAnimationFrame(first);
      scroller.removeEventListener("scroll", update);
    };
  });
</script>

<ul class="toc">
  {#each headings as h (h.id)}<li class={h.sub ? "sub" : undefined}><a href={`#${h.id}`} aria-current={h.id === current ? "location" : undefined} onclick={() => onPick?.()}>{h.text}</a></li>{/each}
</ul>
