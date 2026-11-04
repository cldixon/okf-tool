/**
 * The reader's pure parts (Reader.svelte; tempra-dev: app/reader): comment highlights, what a card
 * is over, and scrolling to a quote from outside the reader (the Comments panel).
 */
import { pointAt } from "./dom";

/** A highlighted range of the text (text offsets), e.g. a comment's quote. */
export interface Highlight {
  id: string;
  from: number;
  to: number;
  active?: boolean;
  /** A comment being written on this range (not yet posted). */
  draft?: boolean;
}

/** What the pointer or focus is on, for a card. */
export type Hovered =
  | { kind: "footnote"; label: string }
  | { kind: "link"; href: string | null; path: string | null; broken: boolean };

/** The names the stylesheet draws (`::highlight(…)`): open threads, the one in focus, the draft. */
export const HIGHLIGHTS = {
  open: "tempra-comment",
  active: "tempra-comment-active",
  draft: "tempra-comment-draft",
} as const;

type Registry = { set(name: string, h: unknown): void; delete(name: string): void };
type HighlightCtor = new (...ranges: Range[]) => unknown;

/** The page's highlight registry, where the browser has one. */
export function highlightRegistry(): { highlights: Registry; Highlight: HighlightCtor } | null {
  const g = globalThis as { CSS?: { highlights?: Registry }; Highlight?: HighlightCtor };
  return g.CSS?.highlights && g.Highlight
    ? { highlights: g.CSS.highlights, Highlight: g.Highlight }
    : null;
}

/** A block of the body that holds open threads' quotes: its mark beside it (TEMPRA-223). */
export interface BlockMark {
  /** The block's first thread (by where its quote starts): the one the mark opens. */
  first: string;
  /** Open threads quoted in it. */
  count: number;
  /** The top-level block (a child of the body's root). */
  block: Element;
}

/**
 * The blocks that hold open threads' quotes, in document order, each with its count and first
 * thread: a quote counts for the top-level block it starts in. The draft is not a thread.
 */
export function blockMarks(root: Element, marks: readonly Highlight[]): BlockMark[] {
  const out = new Map<Element, BlockMark>();
  const open = marks.filter((h) => !h.draft).sort((a, b) => a.from - b.from);
  for (const h of open) {
    const p = pointAt(root, h.from);
    let el: Element | null = p
      ? p.node.nodeType === 1
        ? (p.node as Element)
        : p.node.parentElement
      : null;
    while (el && el.parentElement !== root) el = el.parentElement;
    if (!el) continue;
    const m = out.get(el);
    if (m) m.count++;
    else out.set(el, { first: h.id, count: 1, block: el });
  }
  return [...out.values()];
}

/** A mark's place in the body's box: beside its block in the gutter, or under its end. */
export interface MarkPlace {
  x: number;
  y: number;
  /** No gutter: the mark ends at `x`, under the block's last line. */
  end: boolean;
}

/**
 * Where a block's mark goes, in px from the body's box (`body`): in the right gutter beside the
 * block's first line when `room` (from the text's right edge to the page's) fits `width`, else
 * under the block, ending at its right edge (a phone, a narrow column).
 */
export function placeMark(
  block: DOMRect,
  body: DOMRect,
  textRight: number,
  room: number,
  width: number,
): MarkPlace {
  const gap = 8;
  if (room >= width + gap) {
    return {
      x: Math.round(textRight - body.left + gap),
      y: Math.round(block.top - body.top),
      end: false,
    };
  }
  return {
    x: Math.round(block.right - body.left),
    y: Math.round(block.bottom - body.top),
    end: true,
  };
}

/** The page reader's text, for scrolling to a quote from outside it (the Comments panel). */
function pageRoot(): Element | null {
  return document.querySelector(".doc .body > .prose");
}

/** Scrolls the reader to a text offset (smoothly, unless motion is reduced). */
export function revealOffset(at: number) {
  const root = pageRoot();
  const point = root && pointAt(root, at);
  if (!point) return;
  const el = point.node.nodeType === 1 ? (point.node as Element) : point.node.parentElement;
  const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
  el?.scrollIntoView({ block: "center", behavior: still ? "auto" : "smooth" });
}

/** What a footnote marker or link element is, for its card. */
export function hoveredOf(el: Element): Hovered | null {
  if (el.matches("sup.fnref"))
    return { kind: "footnote", label: el.getAttribute("data-label") ?? "" };
  if (el.matches("a")) {
    return {
      kind: "link",
      href: el.getAttribute("href"),
      path: el.getAttribute("data-path"),
      broken: el.classList.contains("broken"),
    };
  }
  return null;
}

/** The part of an element (a link may wrap lines) nearest a pointer, else its first line. */
export function rectNear(el: Element, x?: number, y?: number): DOMRect {
  const rects = Array.from(el.getClientRects());
  if (x !== undefined && y !== undefined) {
    const hit = rects.find((r) => x >= r.left && x <= r.right && y >= r.top && y <= r.bottom);
    if (hit) return hit;
  }
  return rects[0] ?? el.getBoundingClientRect();
}
