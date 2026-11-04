/**
 * What a page body draws (tempra-dev: app/reader), worked out from its stored tree before any
 * of it is drawn: Body.svelte and Blocks.svelte only turn this into elements. No HTML string is
 * made and nothing is parsed. Every block carries its ID as `data-block`, every textblock its
 * offset in the document's text as `data-text`, and inline content draws exactly the text
 * `docText` reads: a text piece counts its characters, an atom (footnote marker, image, raw
 * markdown, hard break) is one element marked `data-atom` that counts one, and what the diff
 * inserts is marked `data-skip` and counts nothing. dom.ts counts the same way. A paragraph that
 * is one image is a figure (Figure*.svelte): the paragraph keeps its `data-text` element holding
 * the image's atom, and its caption is drawn beside it, outside the text, marked `data-skip`. When
 * footnote references follow the image (TEMPRA-218), their markers are drawn at the caption's end:
 * the figure itself is then the `data-text` element, so the image's atom, the hidden whitespace
 * between them and the markers' atoms read in docText's order, and only the caption's own parts
 * (its number, its text, the image's site) are `data-skip`.
 *
 * Kept apart from the components because the diff's pieces are cut by a cursor through each
 * textblock's text (`Run`), which must walk the inline content once, in order; the components
 * then draw a plain description, keyed by block ID so a block a new version leaves alone keeps
 * its DOM nodes (and the highlights and selection over them).
 */
import {
  type ContainerDirective,
  type DocNode,
  directiveContent,
  directiveLabel,
  type FigureSpec,
  idOf,
  toMarkdown,
  type WordDiff,
} from "@tempra/editor";
import type { Code, Paragraph, PhrasingContent, RootContent, TableCell } from "mdast";
import type { ImageSource } from "../images";
import {
  externalHost,
  type Figure,
  type FigureMarkup,
  type ImageFigure,
  imageSource,
  linkInfo,
  type Prepared,
} from "./prepare";

/** Inline content as drawn: a string is a text piece; the rest are elements. */
export type Inline =
  | string
  /** Text the diff added since the version compared with. */
  | { k: "ins"; text: string }
  /** Words the diff removed (with the space after them), not part of the text. */
  | { k: "del"; text: string }
  | { k: "code" | "strong" | "em" | "s" | "span"; kids: Inline[] }
  /** The text between a group's images (`.figure-gap`). */
  | { k: "gap"; kids: Inline[] }
  | { k: "br" }
  | {
      k: "a";
      href: string | undefined;
      title: string | undefined;
      rel: string | undefined;
      cls: string | undefined;
      path: string | undefined;
      kids: Inline[];
    }
  /** A figure's image, video, audio or PDF (one atom). */
  | { k: "figure"; figure: ImageFigure }
  /**
   * One image of a group, with its title as a small label (one atom), and the markers of the
   * footnote references right after it at the label's end.
   */
  | { k: "cell"; figure: ImageFigure; label: string | null; notes: Inline[] }
  /** An image whose source is dropped: its alt text. */
  | { k: "dropped"; alt: string }
  /** Video, audio or a PDF in running text: a link to its page, named by its alt text. */
  | { k: "media"; href: string; text: string }
  | { k: "img"; source: ImageSource; alt: string; title: string | null; host: string | null }
  | { k: "fn"; label: string; href: string | null; mark: string }
  /** Raw HTML, reference links and images: their markdown, never rendered. */
  | { k: "raw"; text: string };

/** A table cell. */
interface Cell {
  offset: number | undefined;
  align: string | undefined;
  text: Inline[];
}

/** A paragraph of a `:::figure`: its images' textblock. */
interface FigureRow {
  key: string;
  id: string | undefined;
  offset: number | undefined;
  group: boolean;
  text: Inline[];
}

/** A block as drawn. `key` is unique among its siblings: the block's ID where it has one. */
export type Block = { key: string; id: string | undefined } & (
  | { kind: "p"; offset: number | undefined; text: Inline[] }
  /**
   * A paragraph that is one image: the figure, its textblock, and its caption beside it; `notes`,
   * the rest of the textblock after the image (footnote markers, whitespace as gaps), drawn at the
   * caption's end.
   */
  | { kind: "figure"; offset: number | undefined; text: Inline[]; notes: Inline[]; figure: Figure }
  | {
      kind: "heading";
      depth: number;
      anchor: string | undefined;
      offset: number | undefined;
      hidden: boolean;
      text: Inline[];
    }
  | { kind: "blockquote"; blocks: Block[] }
  | {
      kind: "list";
      ordered: boolean;
      start: number | undefined;
      cls: string | undefined;
      items: { key: string; id: string | undefined; checked: boolean | null; blocks: Block[] }[];
    }
  /** A fence, drawn by the registry's component for its language (CodeBlock by default). */
  | {
      kind: "code";
      node: Code;
      lang: string | null;
      offset: number | undefined;
      text: Inline[];
      figure: Figure | undefined;
    }
  /** A node type the registry draws. */
  | {
      kind: "custom";
      type: string;
      node: RootContent;
      offset: number | undefined;
      text: Inline[] | null;
    }
  | { kind: "hr" }
  | { kind: "table"; head: Cell[] | null; rows: Cell[][] }
  /** Figure markup that parses (`:::figure`, tempra-dev: app/media). */
  | {
      kind: "markup";
      spec: FigureSpec;
      count: number;
      rows: FigureRow[];
      labelId: string | undefined;
      number: number;
      /** The label drawn as inline content, else the one image's caption, else none. */
      caption: Inline[] | string | null;
      /** One image's footnote markers, drawn at the caption's end (the figure is the textblock). */
      notes: Inline[];
      /** Where the one image's textblock starts, when its markers are in the caption. */
      offset: number | undefined;
      figures: ImageFigure[];
    }
  /** A directive the reader does not draw: its fences as markdown, its content as usual. */
  | {
      kind: "directive";
      labelId: string | undefined;
      open: string;
      close: string;
      blocks: Block[];
    }
  | { kind: "div"; blocks: Block[] }
  | { kind: "raw"; text: string }
);

/** What draws one body: the prepared tree, the diff over it, whether text offsets are drawn. */
interface Ctx {
  p: Prepared;
  diff: WordDiff | null;
  /** False for content outside the document's text (footnote definitions). */
  offsets: boolean;
  /** Node types the registry draws. */
  custom(type: string): boolean;
}

/** A textblock's text as it is drawn: a cursor through the text, and the diff's pieces there. */
class Run {
  at: number;
  private next = 0;

  constructor(
    from: number,
    private added: { from: number; to: number }[],
    private removed: { pos: number; text: string }[],
  ) {
    this.at = from;
  }

  private del(out: Inline[], upTo: number) {
    while (this.next < this.removed.length && (this.removed[this.next]?.pos ?? 0) <= upTo) {
      const r = this.removed[this.next++];
      out.push({ k: "del", text: `${r?.text} ` });
    }
  }

  /** Text, split where the diff's added ranges start and end and where removed words go. */
  text(value: string): Inline[] {
    const out: Inline[] = [];
    const start = this.at;
    let i = 0;
    while (i < value.length) {
      const pos = start + i;
      this.del(out, pos);
      let end = value.length;
      const nr = this.removed[this.next]?.pos;
      if (nr !== undefined && nr > pos && nr - start < end) end = nr - start;
      const inside = this.added.find((r) => r.from <= pos && pos < r.to);
      if (inside) end = Math.min(end, inside.to - start);
      else {
        const later = this.added.find((r) => r.from > pos);
        if (later) end = Math.min(end, later.from - start);
      }
      const piece = value.slice(i, end);
      out.push(inside ? { k: "ins", text: piece } : piece);
      i = end;
    }
    this.at += value.length;
    return out;
  }

  /** One atom: whatever was removed just before it shows first. */
  atom(out: Inline[], el: Inline) {
    this.del(out, this.at);
    out.push(el);
    this.at += 1;
  }

  /** The end of the textblock: removed words left over show at its end. */
  end(out: Inline[]) {
    this.del(out, this.at);
  }
}

/** A run over the textblock starting at `from`, with the diff's pieces that fall in it. */
function run(ctx: Ctx, n: DocNode): Run {
  const from = ctx.offsets ? (ctx.p.starts.get(n) ?? 0) : 0;
  const tb = ctx.p.text.blocks.find((b) => b.from === from);
  const to = tb?.to ?? from;
  const d = ctx.offsets ? ctx.diff : null;
  return new Run(
    from,
    d ? d.added.filter((r) => r.to > from && r.from < to) : [],
    d ? d.removed.filter((r) => r.pos >= from && r.pos <= to).sort((a, b) => a.pos - b.pos) : [],
  );
}

/** A textblock's offset, as drawn, or nothing outside the document's text. */
const offsetOf = (ctx: Ctx, n: DocNode) => (ctx.offsets ? ctx.p.starts.get(n) : undefined);

/** The markdown a node the reader does not draw reads as, shown as code. */
function rawText(n: DocNode): string {
  return n.type === "html"
    ? n.value
    : toMarkdown({ type: "root", children: [n as RootContent] }).trimEnd();
}

function inline(ctx: Ctx, r: Run, nodes: readonly PhrasingContent[]): Inline[] {
  const out: Inline[] = [];
  for (const n of nodes) {
    switch (n.type) {
      case "text":
        out.push(...r.text(n.value));
        break;
      case "inlineCode":
        out.push({ k: "code", kids: r.text(n.value.replace(/\n/g, " ")) });
        break;
      case "break":
        r.atom(out, { k: "br" });
        break;
      case "strong":
        out.push({ k: "strong", kids: inline(ctx, r, n.children) });
        break;
      case "emphasis":
        out.push({ k: "em", kids: inline(ctx, r, n.children) });
        break;
      case "delete":
        out.push({ k: "s", kids: inline(ctx, r, n.children) });
        break;
      case "link": {
        const info = linkInfo(ctx.p.options, n.url);
        const external = info.href !== null && /^(?:https?:)?\/\//i.test(info.href);
        const cls = [info.path !== null ? "internal" : "", info.broken ? "broken" : ""];
        out.push({
          k: "a",
          href: info.href ?? undefined,
          title: n.title ?? undefined,
          rel: external ? "noopener noreferrer" : undefined,
          cls: cls.filter(Boolean).join(" ") || undefined,
          path: info.path ?? undefined,
          kids: inline(ctx, r, n.children),
        });
        break;
      }
      case "image": {
        const figure = ctx.offsets ? ctx.p.figureOf.get(n) : undefined;
        const source = imageSource(ctx.p.options, n.url);
        r.atom(
          out,
          figure?.kind === "image"
            ? { k: "figure", figure }
            : source === null
              ? { k: "dropped", alt: n.alt ?? "" }
              : source.kind && source.kind !== "image"
                ? { k: "media", href: source.page ?? source.src, text: n.alt || n.url }
                : {
                    k: "img",
                    source,
                    alt: n.alt ?? "",
                    title: n.title ?? null,
                    host: externalHost(n.url),
                  },
        );
        break;
      }
      case "footnoteReference": {
        const m = ctx.p.markers.get(n) ?? { href: null, mark: `[${n.label ?? n.identifier}]` };
        r.atom(out, { k: "fn", label: n.label ?? n.identifier, href: m.href, mark: m.mark });
        break;
      }
      default: {
        const other = n as DocNode;
        if ("children" in other && other.type !== "linkReference") {
          // A wrapper the reader has no element for: its content, as docText reads it.
          out.push({ k: "span", kids: inline(ctx, r, other.children as PhrasingContent[]) });
        } else {
          // Raw HTML, reference links and images: their markdown, never rendered.
          r.atom(out, { k: "raw", text: rawText(other) });
        }
      }
    }
  }
  return out;
}

/** A textblock's inline content, with the diff's leftovers at its end. */
function textblock(ctx: Ctx, n: DocNode, nodes: readonly PhrasingContent[]): Inline[] {
  const r = run(ctx, n);
  const out = inline(ctx, r, nodes);
  r.end(out);
  return out;
}

/**
 * A figure's paragraph (its image first, then only footnote references and whitespace): the
 * image's atom, and what follows it as drawn at the caption's end, whitespace as hidden gaps, in
 * the order docText reads them.
 */
function figureText(ctx: Ctx, n: Paragraph): { text: Inline[]; notes: Inline[] } {
  const r = run(ctx, n);
  const [image, ...rest] = n.children;
  const text = inline(ctx, r, image ? [image] : []);
  const notes: Inline[] = [];
  for (const c of rest) {
    if (c.type === "text") notes.push({ k: "gap", kids: r.text(c.value) });
    else notes.push(...inline(ctx, r, [c]));
  }
  r.end(rest.length > 0 ? notes : text);
  return { text, notes };
}

/** Keys for siblings: each one's ID, else (or when an ID repeats) its place. */
function keys(ids: readonly (string | undefined)[]): string[] {
  const seen = new Set<string>();
  return ids.map((id, i) => {
    if (id === undefined || seen.has(id)) return `#${i}`;
    seen.add(id);
    return id;
  });
}

/**
 * A figure drawn from its markup (`:::figure`, tempra-dev: app/media): its images' paragraph keeps
 * its `data-text`, each image one atom; in a group each image is a cell with its title as a small
 * label (`data-skip`), and the newlines between them are drawn hidden, counted as docText counts
 * them. The caption (the label, else the one image's caption) is outside the text.
 */
function markupFigure(ctx: Ctx, n: ContainerDirective, m: FigureMarkup) {
  const group = m.figures.length > 1;
  const label = directiveLabel(n);
  const content = directiveContent(n);
  const rowKeys = keys(content.map((c) => idOf(c)));
  const rows: FigureRow[] = [];
  // One image's footnote markers go to the caption's end, a group's to its image's label.
  const notes: Inline[] = [];
  let textOffset: number | undefined;
  content.forEach((c, i) => {
    if (c.type !== "paragraph") return;
    const r = run(ctx, c);
    const out: Inline[] = [];
    let cell: Extract<Inline, { k: "cell" }> | null = null;
    const where = () => (group ? (cell?.notes ?? out) : notes);
    c.children.forEach((child, j) => {
      if (child.type === "text") {
        // Whitespace before an image's footnote reference goes with the reference.
        const before = c.children[j + 1]?.type === "footnoteReference";
        (before ? where() : out).push({ k: "gap", kids: r.text(child.value) });
        return;
      }
      if (child.type === "footnoteReference") {
        where().push(...inline(ctx, r, [child]));
        return;
      }
      const f = child.type === "image" ? ctx.p.figureOf.get(child) : undefined;
      if (f?.kind !== "image") return;
      if (group) {
        cell = { k: "cell", figure: f, label: f.image.title?.trim() || null, notes: [] };
        r.atom(out, cell);
      } else r.atom(out, { k: "figure", figure: f });
    });
    const inCaption = !group && notes.length > 0;
    if (inCaption) {
      r.end(notes);
      textOffset = offsetOf(ctx, c);
    } else r.end(out);
    rows.push({
      key: rowKeys[i] ?? `#${i}`,
      id: idOf(c),
      offset: inCaption ? undefined : offsetOf(ctx, c),
      group,
      text: out,
    });
  });
  const first = m.figures[0];
  const caption = label
    ? inline(
        { ...ctx, offsets: false, diff: null },
        run({ ...ctx, offsets: false }, label),
        label.children,
      )
    : group
      ? null
      : (first?.caption ?? null);
  return {
    kind: "markup" as const,
    spec: m.spec,
    count: m.figures.length,
    rows,
    labelId: label ? idOf(label) : undefined,
    number: first?.n ?? 1,
    caption,
    notes,
    offset: textOffset,
    figures: m.figures,
  };
}

/**
 * A directive the reader does not draw (another name, or figure markup that does not parse): its
 * opening and closing lines as their markdown, outside the text, and its content drawn as usual.
 */
function rawDirective(ctx: Ctx, n: ContainerDirective) {
  const lines = rawText(n).split("\n");
  const label = directiveLabel(n);
  return {
    kind: "directive" as const,
    labelId: label ? idOf(label) : undefined,
    open: lines[0] ?? "",
    close: lines.at(-1) ?? "",
    blocks: blocks(ctx, directiveContent(n)),
  };
}

function cell(ctx: Ctx, c: TableCell, align: string | null | undefined): Cell {
  return {
    offset: offsetOf(ctx, c),
    align: align ?? undefined,
    text: textblock(ctx, c, c.children),
  };
}

type Drawn = Block extends infer B ? (B extends Block ? Omit<B, "key" | "id"> : never) : never;

function block(ctx: Ctx, n: RootContent, hidden: boolean): Drawn | null {
  if (ctx.custom(n.type)) {
    const offset = offsetOf(ctx, n);
    const text =
      "children" in n && offset !== undefined && n.type !== "table"
        ? textblock(ctx, n, n.children as PhrasingContent[])
        : null;
    return { kind: "custom", type: n.type, node: n, offset, text };
  }
  switch (n.type) {
    case "paragraph": {
      const figure = ctx.offsets ? ctx.p.figureOf.get(n) : undefined;
      const offset = offsetOf(ctx, n);
      if (!figure) return { kind: "p", offset, text: textblock(ctx, n, n.children) };
      return { kind: "figure", offset, ...figureText(ctx, n), figure };
    }
    case "heading":
      return {
        kind: "heading",
        depth: n.depth,
        anchor: ctx.p.anchors.get(n),
        offset: offsetOf(ctx, n),
        hidden,
        text: textblock(ctx, n, n.children),
      };
    case "blockquote":
      return { kind: "blockquote", blocks: blocks(ctx, n.children) };
    case "list": {
      const tasks = n.children.some((i) => typeof i.checked === "boolean");
      const cls = [n.spread ? "loose" : "", tasks ? "tasks" : ""].filter(Boolean).join(" ");
      const itemKeys = keys(n.children.map((item) => idOf(item)));
      return {
        kind: "list",
        ordered: !!n.ordered,
        start: n.ordered && n.start != null && n.start !== 1 ? n.start : undefined,
        cls: cls || undefined,
        items: n.children.map((item, i) => ({
          key: itemKeys[i] ?? `#${i}`,
          id: idOf(item),
          checked: typeof item.checked === "boolean" ? item.checked : null,
          blocks: blocks(ctx, item.children),
        })),
      };
    }
    case "code": {
      const r = run(ctx, n);
      const text = r.text(n.value);
      r.end(text);
      return {
        kind: "code",
        node: n,
        lang: n.lang ? n.lang.toLowerCase() : null,
        offset: offsetOf(ctx, n),
        text,
        figure: ctx.offsets ? ctx.p.figureOf.get(n) : undefined,
      };
    }
    case "thematicBreak":
      return { kind: "hr" };
    case "table": {
      const [head, ...body] = n.children;
      return {
        kind: "table",
        head: head ? head.children.map((c, i) => cell(ctx, c, n.align?.[i])) : null,
        rows: body.map((row) => row.children.map((c, i) => cell(ctx, c, n.align?.[i]))),
      };
    }
    case "footnoteDefinition":
      // Shown beside the body (Contents & sources, the marker's card), not in it.
      return null;
    case "containerDirective": {
      const m = ctx.offsets ? ctx.p.markup.get(n) : undefined;
      return m ? markupFigure(ctx, n, m) : rawDirective(ctx, n);
    }
    default:
      if ("children" in n) return { kind: "div", blocks: blocks(ctx, n.children as RootContent[]) };
      // Raw HTML blocks and definitions: their markdown, as code, never rendered.
      return { kind: "raw", text: rawText(n) };
  }
}

function blocks(ctx: Ctx, nodes: readonly RootContent[], hideFirst = false): Block[] {
  const ids = keys(nodes.map((n) => idOf(n)));
  const out: Block[] = [];
  nodes.forEach((n, i) => {
    const b = block(ctx, n, hideFirst && i === 0);
    if (b) out.push({ ...b, key: ids[i] ?? `#${i}`, id: idOf(n) } as Block);
  });
  return out;
}

/**
 * The body's blocks. `hideFirst` keeps a leading heading that repeats the title in the DOM, hidden,
 * so offsets stay where the text has them. `custom` names the node types the registry draws.
 */
export function bodyBlocks(
  p: Prepared,
  diff: WordDiff | null,
  hideFirst: boolean,
  custom: (type: string) => boolean = () => false,
): Block[] {
  return blocks({ p, diff, offsets: true, custom }, p.tree.children, hideFirst);
}

/** Content beside the body (a footnote definition), drawn the same way, outside the text. */
export function noteBlocks(
  p: Prepared,
  nodes: readonly RootContent[],
  custom: (type: string) => boolean = () => false,
): Block[] {
  return blocks({ p, diff: null, offsets: false, custom }, nodes);
}
