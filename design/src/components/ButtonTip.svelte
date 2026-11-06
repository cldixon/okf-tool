<script lang="ts">
  /**
   * A button's tip (TEMPRA-312): a few words under the button for a moment once it has acted
   * ("Copied", "Couldn't copy"), in the top layer (`.button-tip`, `popover="manual"`), and the
   * same words in a polite live region for a screen reader. Shown while `text` is set; the caller
   * clears it. Its place is set through the CSSOM, as the reader's cards are (`--float-x`,
   * `--float-y`; CSP: no style attribute). Under the button, above it where there is no room.
   * Used by IconButton and SplitButton through their `tip`; not exported on its own.
   */
  let { text, anchor }: { text: string | null; anchor: HTMLElement | undefined } = $props();
  let el: HTMLDivElement | undefined = $state();

  $effect(() => {
    if (!text || !el || !anchor) return;
    if (typeof el.showPopover === "function" && !el.matches(":popover-open")) el.showPopover();
    const r = anchor.getBoundingClientRect();
    const gap = 6;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const x = Math.max(gap, Math.min(r.left + r.width / 2 - w / 2, window.innerWidth - w - gap));
    const below = r.bottom + gap;
    const y = below + h + gap <= window.innerHeight ? below : Math.max(gap, r.top - h - gap);
    el.style.setProperty("--float-x", `${Math.round(x)}px`);
    el.style.setProperty("--float-y", `${Math.round(y)}px`);
  });
</script>

{#if text}<div bind:this={el} popover="manual" class="button-tip" aria-hidden="true">{text}</div
  >{/if}<span class="visually-hidden" aria-live="polite">{text ?? ""}</span>
