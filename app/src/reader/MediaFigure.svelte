<script lang="ts">
  /**
   * Figures that are not images (TEMPRA-164; tempra-dev: app/media, How people see): the same
   * markdown as an image (`![A walkthrough](/x/demo.mp4 "Caption")`), drawn by what the attachment
   * is (its source's `kind`), through the reader's registry (registry.ts, `media`):
   *
   * - a video (MP4, WebM): Player.svelte, with an Enlarge button to play it in the full-screen view;
   * - audio (MP3, Ogg, WAV): Player.svelte;
   * - a PDF: a card (PdfCard.svelte) with its name, type and size, Open (its attachment page) and
   *   Download; no embedded viewer.
   *
   * Each is the paragraph's one atom, as an image is: one element marked `data-atom`, counting one
   * character in `docText`, so comment anchors and the diff are unchanged. One that fails to play
   * is the broken box, saying so.
   */
  import { Icon } from "@tempra/design/components";
  import { baseName } from "../urls";
  import BrokenImage from "./BrokenImage.svelte";
  import { useOpenFigure } from "./open-figure";
  import PdfCard from "./PdfCard.svelte";
  import Player from "./Player.svelte";
  import type { MediaProps } from "./registry";

  let { figure }: MediaProps = $props();
  const kind = $derived(figure.source?.kind === "audio" ? "audio" : "video");
  const pdf = $derived(figure.source?.kind === "pdf");
  const open = useOpenFigure();
  let failed = $state<string | null>(null);
  /** What a media figure is called to a screen reader: its alt text, else its caption or name. */
  const name = $derived(
    figure.alt || figure.caption || (figure.path ? baseName(figure.path) : figure.url),
  );
  /** Clicks on a player or a card are not clicks on the text (no thread to open or close). */
  const own = (e: MouseEvent) => e.stopPropagation();
</script>

{#if pdf}
  <!-- The span only keeps the card's clicks its own; its links handle their own keys. -->
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
  <span class="figure-media" data-atom="" onclick={own}><PdfCard {figure} /></span
  >{:else if figure.source === null || failed === figure.source.src}<BrokenImage
    {figure}
    atom
  />{:else}{@const source = figure.source}
  <!-- The span only keeps the player's clicks its own; the player handles its own keys. -->
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
  <span class={`figure-media figure-${kind}`} data-atom="" onclick={own}
    ><Player {kind} {source} {name} onError={() => (failed = source.src)} />{#if open && kind === "video"}<span
        class="figure-tools"
        data-skip=""
        ><button
          type="button"
          class="figure-enlarge"
          aria-label={`Enlarge video: ${name}`}
          onclick={() => open(figure.n)}><Icon name="enlarge" size={14} /></button
        ></span
      >{/if}</span
  >{/if}
