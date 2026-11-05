<script lang="ts">
  /**
   * A fence drawn as a figure (tempra-dev: app/diagrams): a `mermaid` fence as a diagram, the
   * registry's first entry, and an `svg` fence as its sanitized SVG (TEMPRA-206), named by its
   * `alt="…"` or its own <title>.
   * Pele loads on demand (./pele.ts, through diagram.ts); the figure is drawn at its width and
   * again when that changes. It sits in a quiet frame with its caption below ("Figure n." and the
   * fence's `title="…"`) and two small controls in its corner: Source (the Mermaid source in
   * place, and back) and Enlarge (the full-screen view, Lightbox.svelte). What it draws, the
   * controls included, is opaque to comments (`data-opaque`), and the controls and caption are not
   * text (`data-skip`). A diagram that fails shows its source as the default code block would,
   * where comments can anchor, with a quiet notice under it.
   */

  import { Button, Icon } from "@tempra/design/components";
  import type { Code } from "mdast";
  import Caption from "./Caption.svelte";
  import { drawDiagram, fenceAlt, figureLang } from "./diagram";
  import { useOpenFigure } from "./open-figure";
  import type { BlockProps } from "./registry";

  let { node, id, offset, text, figure }: BlockProps<Code> = $props();
  const open = useOpenFigure();
  let showSource = $state(false);
  let failed = $state.raw<{ source: string; message: string } | null>(null);
  const failure = $derived(failed?.source === node.value ? failed.message : null);
  const captionId = $props.id();
  const lang = $derived(figureLang(node.lang));
  // An SVG or a chart says what it shows (its alt); a Mermaid diagram is named by its caption (C-28).
  const alt = $derived(fenceAlt(lang, node.meta, node.value));
  const kind = $derived(lang === "svg" ? "SVG" : lang === "vega-lite" ? "Chart" : "Diagram");
  const fail = (source: string, message: string) => {
    failed = { source, message };
  };
</script>

{#if failure !== null}
  <figure class="diagram failed" data-block={id}
    ><pre data-text={offset} data-lang={lang}><code>{@render text?.()}</code></pre><p
      class="diagram-notice"
      data-skip="">{kind} not drawn: {failure}</p
    >{#if figure}<Caption {figure} id={captionId} />{/if}</figure
  >
{:else}
  <figure class="diagram" data-block={id} data-opaque=""
    ><div class="diagram-frame"
      >{#if showSource}<pre class="diagram-source" data-lang={lang}><code>{node.value}</code></pre
        >{:else}<!-- One image to a screen reader, named by its caption ("Figure 2. The flow"; C-28). --><div
            class="diagram-svg"
            role="img"
            aria-labelledby={figure && !alt ? captionId : undefined}
            aria-label={alt ?? (figure ? undefined : kind)}
            {@attach drawDiagram(node.value, `d${id ?? ""}-`, fail, lang, figure?.kind === "diagram" ? figure.chart : undefined)}
          ></div
        >{/if}<span class="figure-tools" data-skip=""
        ><Button aria-pressed={showSource} onclick={(e) => {
            e.stopPropagation();
            showSource = !showSource;
          }}>Source</Button>{#if open && figure}<button
            type="button"
            class="figure-enlarge"
            aria-label={`Enlarge ${lang === "mermaid" ? "diagram" : lang === "svg" ? "figure" : "chart"}${figure.caption ? `: ${figure.caption}` : ""}`}
            onclick={(e) => {
              e.stopPropagation();
              open(figure.n);
            }}><Icon name="enlarge" size={14} /></button
          >{/if}</span
      ></div
    >{#if figure}<Caption {figure} id={captionId} />{/if}</figure
  >
{/if}
