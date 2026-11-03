<script lang="ts">
  /** What an image can't show: the box that keeps its place, saying why, its path and alt text. */
  import { Icon } from "@tempra/design/components";
  import type { ImageFigure } from "./prepare";

  let { figure, atom }: { figure: ImageFigure; atom?: boolean } = $props();
  const where = $derived(figure.path ?? figure.url);
  const kind = $derived(figure.source?.kind);
  // A video or audio file that does not play says so (TEMPRA-164); anything else is an image.
  const playable = $derived(kind === "video" || kind === "audio");
  const what = $derived(
    playable
      ? `This ${kind}`
      : figure.host
        ? `This external image from ${figure.host}`
        : "This image",
  );
  const verb = $derived(playable ? "can't be played" : "can't be shown");
</script>

<span
  class="figure-broken"
  data-atom={atom ? "" : undefined}
  role="img"
  aria-label={`${what} ${verb}: ${figure.alt || where}`}
  ><Icon name={playable ? (kind as "video" | "audio") : "broken"} size={20} /><span
    class="figure-broken-title">{playable ? `This ${kind} ${verb}` : "This image can't be shown"}</span
  >{#if figure.host}<span>An external image from {figure.host}</span>{/if}<span>{where}</span
  >{#if figure.alt}<span>Alt text: “{figure.alt}”</span>{/if}</span
>
