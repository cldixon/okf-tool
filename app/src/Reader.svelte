<script lang="ts" generics="C">
  /**
   * A page body in the reader (tempra-dev: app/reader): the stored tree drawn as elements
   * (reader/Body.svelte), with the overlays a person reads with. Comment quotes are drawn with the
   * CSS Custom Highlight API, so drawing or clearing one never touches the body; hovering or
   * focusing a footnote marker or a link shows a card; selecting text shows a small toolbar
   * (Comment). The two popovers live in the top layer; the app sets only their coordinates, the
   * look is the design package's.
   *
   * The body draws again only when what it shows changes (`prepared`, `diff`, `hideFirst`), never
   * for a card, a highlight or the toolbar; a new version redraws only the blocks it changed.
   */
  import type { WordDiff } from "@tempra/editor";
  import type { Snippet } from "svelte";
  import Body from "./reader/Body.svelte";
  import CommentMarks from "./reader/CommentMarks.svelte";
  import { offsetAtPoint, rangeOf, selectionAt } from "./reader/dom";
  import Floating from "./reader/Floating.svelte";
  import Lightbox from "./reader/Lightbox.svelte";
  import type { FigureView } from "./reader/lightbox";
  import { provideOpenFigure } from "./reader/open-figure";
  import type { Prepared } from "./reader/prepare";
  import {
    HIGHLIGHTS,
    type Highlight,
    type Hovered,
    highlightRegistry,
    hoveredOf,
    rectNear,
  } from "./reader/reading";
  import { commentKey } from "./ui";

  let {
    prepared,
    diff,
    hideFirst,
    hover,
    card,
    highlights,
    onMark,
    onComment,
    figureView,
  }: {
    prepared: Prepared;
    diff: WordDiff | null;
    hideFirst: boolean;
    /** What the card for a footnote marker or link shows, or null for none. */
    hover?(h: Hovered): C | Promise<C | null> | null;
    /** Draws a card from what `hover` gave. */
    card?: Snippet<[C]>;
    /** Ranges to highlight (comment quotes); changing them does not redraw the body. */
    highlights?: readonly Highlight[];
    /** A highlight was clicked (its id), or the body outside one (null). */
    onMark?(id: string | null): void;
    /** Offers Comment on selected text (text offsets). */
    onComment?(range: { from: number; to: number }): void;
    /** What the full-screen view of a figure shows beyond the figure (title, an image's facts). */
    figureView?: FigureView;
  } = $props();
  let root: HTMLDivElement | undefined = $state();

  // Comment highlights: ranges over the drawn text, redrawn whenever the text or the marks change.
  $effect(() => {
    const reg = highlightRegistry();
    const el = root;
    const marks = highlights;
    // The drawn text: the body has drawn these by the time this runs.
    void [prepared, diff, hideFirst];
    if (!reg || !el || marks === undefined) return;
    const sets = { open: [] as Range[], active: [] as Range[], draft: [] as Range[] };
    for (const h of marks) {
      const range = rangeOf(el, h.from, h.to);
      if (!range) continue;
      sets[h.draft ? "draft" : h.active ? "active" : "open"].push(range);
    }
    for (const k of Object.keys(HIGHLIGHTS) as (keyof typeof HIGHLIGHTS)[]) {
      reg.highlights.set(HIGHLIGHTS[k], new reg.Highlight(...sets[k]));
    }
    return () => {
      for (const name of Object.values(HIGHLIGHTS)) reg.highlights.delete(name);
    };
  });

  // Cards over footnote markers and links.
  let shownCard = $state.raw<{ el: Element; rect: DOMRect; content: C } | null>(null);
  let pending: Element | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  function hide(delay: number) {
    clearTimeout(timer);
    pending = null;
    timer = setTimeout(() => {
      shownCard = null;
    }, delay);
  }
  function show(el: Element, delay: number, x?: number, y?: number) {
    clearTimeout(timer);
    if (pending === el) return;
    pending = el;
    timer = setTimeout(async () => {
      const what = hoveredOf(el);
      const content = what && hover ? await hover(what) : null;
      if (pending !== el) return;
      shownCard = content != null ? { el, rect: rectNear(el, x, y), content } : null;
    }, delay);
  }
  $effect(() => () => clearTimeout(timer));
  // A card is its trigger's description (the marker's link, or the link), and Escape closes it
  // (C-27, TEMPRA-133).
  const cardId = $props.id();
  $effect(() => {
    const c = shownCard;
    if (!c) return;
    const trigger = c.el.matches("a") ? c.el : (c.el.querySelector("a") ?? c.el);
    trigger.setAttribute("aria-describedby", cardId);
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      e.preventDefault();
      clearTimeout(timer);
      pending = null;
      shownCard = null;
    };
    document.addEventListener("keydown", onKey, true);
    return () => {
      trigger.removeAttribute("aria-describedby");
      document.removeEventListener("keydown", onKey, true);
    };
  });
  const targetOf = (t: EventTarget | null) => {
    // A marker's own link is the marker: its card is the source, not the link.
    const el = t instanceof Element ? (t.closest("sup.fnref") ?? t.closest("a")) : null;
    return el && root?.contains(el) ? el : null;
  };

  // The selection toolbar: shown once the selection settles, gone as soon as it does.
  let tools = $state.raw<{ range: { from: number; to: number }; rect: DOMRect } | null>(null);
  $effect(() => {
    const comment = onComment;
    const text = prepared.text.text;
    if (!comment) return;
    let wait: ReturnType<typeof setTimeout> | undefined;
    const follow = () => {
      clearTimeout(wait);
      wait = setTimeout(() => {
        const el = root;
        const sel = document.getSelection();
        const at = el ? selectionAt(el, sel) : null;
        if (!at || !sel || !text.slice(at.from, at.to).trim()) {
          tools = null;
          return;
        }
        tools = { range: at, rect: sel.getRangeAt(0).getBoundingClientRect() };
      }, 120);
    };
    // From the keyboard (C-27, TEMPRA-133): Ctrl+Alt+M (Cmd+Option+M on a Mac), as in other
    // editors, comments on the selected text, toolbar or not.
    const key = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || !e.altKey || e.code !== "KeyM") return;
      const el = root;
      const sel = document.getSelection();
      const at = el ? selectionAt(el, sel) : null;
      if (!at || !text.slice(at.from, at.to).trim()) return;
      e.preventDefault();
      clearTimeout(wait);
      tools = null;
      comment(at);
      sel?.removeAllRanges();
    };
    document.addEventListener("selectionchange", follow);
    document.addEventListener("keydown", key);
    return () => {
      clearTimeout(wait);
      document.removeEventListener("selectionchange", follow);
      document.removeEventListener("keydown", key);
    };
  });
  // Scrolling: the card follows its marker or link, the toolbar its text.
  $effect(() => {
    const scrolled = () => {
      if (shownCard) shownCard = { ...shownCard, rect: rectNear(shownCard.el) };
      const sel = document.getSelection();
      if (tools && sel && sel.rangeCount > 0) {
        tools = { ...tools, rect: sel.getRangeAt(0).getBoundingClientRect() };
      }
    };
    document.addEventListener("scroll", scrolled, { capture: true, passive: true });
    return () => document.removeEventListener("scroll", scrolled, { capture: true });
  });

  // The full-screen view: the figure shown (its number), or none.
  let shown = $state<number | null>(null);
  provideOpenFigure((n) => {
    shown = n;
  });

  const click = (e: MouseEvent) => {
    // A click that ends a selection is not a click on a highlight.
    if (!onMark || !root || !(document.getSelection()?.isCollapsed ?? true)) return;
    const at = offsetAtPoint(root, e.clientX, e.clientY);
    const hit =
      at === null
        ? undefined
        : (highlights ?? [])
            .filter((h) => !h.draft && h.from <= at && at <= h.to)
            .sort((a, b) => a.to - a.from - (b.to - b.from))[0];
    onMark(hit?.id ?? null);
  };
</script>

<div class="body">
  <!-- A click on a highlighted quote opens its thread, which the Comments panel also lists. -->
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
  <div
    bind:this={root}
    class="prose"
    onclick={click}
    onpointerover={(e) => {
      const el = targetOf(e.target);
      if (el) show(el, 250, e.clientX, e.clientY);
    }}
    onpointerout={(e) => {
      const el = targetOf(e.target);
      if (el && !(e.relatedTarget instanceof Node && el.contains(e.relatedTarget))) hide(200);
    }}
    onfocusin={(e) => {
      const el = targetOf(e.target);
      if (el) show(el, 0);
    }}
    onfocusout={() => hide(0)}
  >
    <Body {prepared} {diff} {hideFirst} />
  </div>
  {#if root && onMark && highlights && highlights.some((h) => !h.draft)}
    <!-- A mark beside each block with open threads, outside the counted text (TEMPRA-223). -->
    <CommentMarks {root} {highlights} {prepared} {diff} {hideFirst} onOpen={(id) => onMark?.(id)} />
  {/if}
  {#if shown !== null && prepared.figures[shown - 1]}
    <Lightbox
      figures={prepared.figures}
      at={shown}
      view={figureView}
      onMove={(n) => (shown = n)}
      onClose={() => (shown = null)}
    />
  {/if}
  {#if shownCard && card}
    {@const content = shownCard.content}
    <Floating
      rect={shownCard.rect}
      id={cardId}
      role="tooltip"
      class="tooltip"
      onpointerenter={() => clearTimeout(timer)}
      onpointerleave={() => hide(200)}
    >
      {@render card(content)}
    </Floating>
  {/if}
  {#if tools && onComment}
    <Floating rect={tools.rect} class="selection-tools">
      <div role="toolbar" aria-label="Selection">
        <!-- Pressing the button must not take the selection away first. -->
        <button
          type="button"
          title={`Comment (${commentKey()})`}
          aria-keyshortcuts="Control+Alt+M Meta+Alt+M"
          onmousedown={(e) => e.preventDefault()}
          onclick={() => {
            const range = tools?.range;
            if (!range) return;
            tools = null;
            onComment(range);
            // The draft highlight takes over from the browser's selection.
            document.getSelection()?.removeAllRanges();
          }}>Comment</button
        >
      </div>
    </Floating>
  {/if}
</div>
