<script lang="ts">
  /** A PDF's card: its name, type and size, Open and Download. Also the full-screen view's. */
  import { Icon } from "@tempra/design/components";
  import { formatSize } from "../ui";
  import { baseName } from "../urls";
  import BrokenImage from "./BrokenImage.svelte";
  import type { ImageFigure } from "./prepare";

  let { figure, atom }: { figure: ImageFigure; atom?: boolean } = $props();
  const name = $derived(figure.path ? baseName(figure.path) : figure.url);
</script>

{#if figure.source === null}<BrokenImage {figure} {atom} />{:else}{@const source = figure.source}
  <span class="figure-pdf" data-atom={atom ? "" : undefined}
    ><Icon name="file" size={24} /><span class="figure-pdf-about"
      ><span class="figure-pdf-name">{name}</span><span class="figure-pdf-meta"
        >PDF document{source.size !== undefined ? ` · ${formatSize(source.size)}` : ""}</span
      ></span
    ><span class="figure-pdf-actions"
      >{#if source.page}<a class="button" href={source.page}>Open</a>{/if}<a
        class="button"
        href={source.download ?? source.src}
        download={name}><Icon name="download" /> Download</a
      ></span
    ></span
  >{/if}
