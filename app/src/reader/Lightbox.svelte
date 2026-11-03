<script lang="ts">
  /**
   * The full-screen view of a concept's figures (tempra-dev: app/reader, Figures): over the app on
   * the ground colour, the image (or the diagram, drawn again at the view's size) as large as
   * fits, previous and next through the concept's figures ("fig. n of m"), Escape to close. For an
   * image, Download and Open file (its attachment page; "Open original" for an external image) as
   * pills, and beneath the caption a quiet line: its path, size, the host it was fetched from, who
   * added it and what it shows (TEMPRA-170), asked of the page when the view opens
   * (`FigureView.describe`); an external image shows its URL. A video plays here and audio too; a
   * PDF is its card, Open going to its page (TEMPRA-164).
   *
   * A modal <dialog> (showModal: the top layer, focus kept inside, Escape), its look in reader.css.
   */

  import { Icon } from "@tempra/design/components";
  import { untrack } from "svelte";
  import DiagramStage from "./DiagramStage.svelte";
  import ImageStage from "./ImageStage.svelte";
  import { type FigureView, factsLine, type ImageFacts } from "./lightbox";
  import type { Figure } from "./prepare";

  let {
    figures,
    at,
    view,
    onMove,
    onClose,
  }: {
    figures: readonly Figure[];
    /** The figure shown (its number, from 1). */
    at: number;
    view?: FigureView;
    onMove(n: number): void;
    onClose(): void;
  } = $props();
  const figure = $derived(figures[at - 1]);
  let dialog: HTMLDialogElement | undefined = $state();
  let close: HTMLButtonElement | undefined = $state();
  const uid = $props.id();
  const label = `${uid}-label`;
  const caption = `${uid}-caption`;

  // Opened modally once, closed (and the focus given back) when it goes.
  $effect(() => {
    const el = dialog;
    if (!el) return;
    return untrack(() => {
      const before = el.ownerDocument.activeElement as HTMLElement | null;
      if (!el.open) {
        if (typeof el.showModal === "function") el.showModal();
        else el.setAttribute("open", "");
      }
      close?.focus();
      return () => {
        if (el.open && typeof el.close === "function") el.close();
        before?.focus?.();
      };
    });
  });

  // The facts under an image in the library, asked once per path.
  const cache = new Map<string, ImageFacts | null>();
  let facts = $state.raw<{ path: string; facts: ImageFacts | null } | null>(null);
  const path = $derived(figure?.kind === "image" ? figure.path : null);
  $effect(() => {
    const p = path;
    const describe = view?.describe;
    if (p === null || !describe) return;
    if (cache.has(p)) {
      facts = { path: p, facts: cache.get(p) ?? null };
      return;
    }
    let live = true;
    describe(p).then(
      (f) => {
        cache.set(p, f);
        if (live) facts = { path: p, facts: f };
      },
      () => {
        if (live) facts = { path: p, facts: null };
      },
    );
    return () => {
      live = false;
    };
  });

  const total = $derived(figures.length);
  const prev = $derived(at > 1 ? at - 1 : null);
  const next = $derived(at < total ? at + 1 : null);
  const image = $derived(figure?.kind === "image" ? figure : null);
  const line = $derived(
    image ? factsLine(image, facts?.path === image.path ? facts.facts : null) : null,
  );

  const keys = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      // The view's own: no page-wide Escape (a drawer, a menu) acts on it too.
      e.preventDefault();
      e.stopPropagation();
      onClose();
    } else if (e.key === "ArrowLeft" && prev !== null) {
      e.preventDefault();
      onMove(prev);
    } else if (e.key === "ArrowRight" && next !== null) {
      e.preventDefault();
      onMove(next);
    }
  };
</script>

{#if figure}
  <dialog
    bind:this={dialog}
    class="lightbox"
    aria-labelledby={label}
    aria-describedby={figure.caption ? caption : undefined}
    onkeydown={keys}
    oncancel={(e) => {
      e.preventDefault();
      onClose();
    }}
  >
    <header class="lightbox-head"
      >{#if view?.title}<span class="lightbox-where">{view.title}</span>{/if}<span id={label}
        >fig. {figure.n} of {total}</span
      ><span class="lightbox-actions"
        >{#if image?.src}<a
            href={image.path && view?.downloadHref ? view.downloadHref(image.path) : image.src}
            download=""><Icon name="download" /> Download</a
          >{/if}{#if image?.path && view?.fileHref}<a href={view.fileHref(image.path)} onclick={onClose}
            >Open file</a
          >{:else if image?.src}<a href={image.src} target="_blank" rel="noopener noreferrer"
            >Open original</a
          >{/if}<button
          bind:this={close}
          type="button"
          class="lightbox-round"
          aria-label="Close"
          onclick={onClose}><Icon name="close" /></button
        ></span
      ></header
    ><div class="lightbox-stage"
      >{#if total > 1}<button
          type="button"
          class="lightbox-round lightbox-prev"
          aria-label="Previous figure"
          disabled={prev === null}
          onclick={() => prev !== null && onMove(prev)}><Icon name="previous" size={18} /></button
        >{/if}{#key figure.n}<div class="lightbox-figure"
          >{#if figure.kind === "image"}<ImageStage {figure} />{:else}<DiagramStage
              {figure}
            />{/if}</div
        >{/key}{#if total > 1}<button
          type="button"
          class="lightbox-round lightbox-next"
          aria-label="Next figure"
          disabled={next === null}
          onclick={() => next !== null && onMove(next)}><Icon name="next" size={18} /></button
        >{/if}</div
    ><footer class="lightbox-foot"
      >{#if figure.caption}<p class="lightbox-caption" id={caption}>{figure.caption}</p
        >{/if}<p class="lightbox-facts"
        >{#if line}<span>{line}</span>{/if}<span class="lightbox-hint"
          >Esc to close{total > 1 ? ", ← → between figures" : ""}</span
        ></p
      ></footer
    >
  </dialog>
{/if}
