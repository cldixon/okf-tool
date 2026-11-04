/**
 * A stored body made ready to draw (tempra-dev: app/reader): where each textblock starts in the
 * document's text ({@link docText}, which comment anchors count in), each heading's anchor, each
 * footnote reference's marker, and the footnote definitions kept beside the body. Pure and
 * DOM-free: the reader's components (Body.svelte, Blocks.svelte) only read it.
 */
import {
  type ContainerDirective,
  type Doc,
  type DocNode,
  type DocText,
  docText,
  type FigureSpec,
  fenceTitle,
  findFigures,
  headingText,
  isDirectiveLabel,
  type LinkTarget,
  linkTarget,
  slugger,
  walk,
} from "@tempra/editor";
import type { Code, FootnoteDefinition, FootnoteReference, Image, Nodes, Paragraph } from "mdast";
import type { ImageSource } from "../images";
import type { ChartSource } from "./diagram";

/** How links, images and footnote references in a body point. All optional. */
export interface BodyOptions {
  /** The page's library path, for relative links. */
  path?: string;
  /**
   * The href for a link or image target, given how it was classified (null when its scheme is
   * unsafe). Return null to drop the link. Defaults to safe external URLs and anchors only.
   */
  href?(target: LinkTarget | null, raw: string, kind: "link" | "image"): string | null;
  /** Library paths links may point to, when known: others are marked broken. */
  exists?(path: string, dir: boolean): boolean;
  /**
   * Where a footnote reference points and what its marker shows (a source's number). `defined`
   * says whether the body has a `[^label]: …` definition. Null: no link, the label in brackets.
   * Called once per reference, in reading order (the body, then the definitions).
   */
  footnote?(label: string, defined: boolean): { href: string | null; mark: string } | null;
  /**
   * How an image stored in the library at `path` loads: the image route by hash, its candidates
   * and its size (TEMPRA-162). Null or absent: the `href` for the image, with no size.
   */
  image?(path: string): ImageSource | null;
  /** A library file's text, for a chart's data (TEMPRA-207); null when there is none. */
  fileText?(path: string): Promise<string | null>;
}

export interface Heading {
  depth: number;
  text: string;
  /** Its anchor, as the server slugs it. */
  id: string;
  /** The body's first block. */
  first: boolean;
}

/** A footnote definition, shown beside the body (Contents & sources, the marker's card). */
export interface Footnote {
  label: string;
  identifier: string;
  node: FootnoteDefinition;
}

/**
 * A figure (tempra-dev: app/reader, Figures): an image that is a paragraph's only content (with
 * the footnote references right after it, TEMPRA-218), or a fence drawn as a diagram. Numbered in document order, from 1, so "Figure n." is stable.
 */
export type Figure = ImageFigure | DiagramFigure;

interface FigureBase {
  /** Its number, from 1, in document order. */
  n: number;
  /** The image's title, else its alt text; a diagram's `title="…"` after the fence's language. */
  caption: string | null;
}

export interface ImageFigure extends FigureBase {
  kind: "image";
  /** The paragraph that holds it (its textblock). */
  node: Paragraph;
  image: Image;
  /** As written in the body. */
  url: string;
  alt: string;
  /** Where it loads from (`href`), or null when it is not shown. */
  src: string | null;
  /** Where it loads from with its candidates and size when known (`imageSource`); null with `src`. */
  source: ImageSource | null;
  /** The library path it resolves to, when it is internal. */
  path: string | null;
  /** The site it is hotlinked from (`externalHost`), when it is external (TEMPRA-163). */
  host: string | null;
  /** The figure markup it is drawn by (`:::figure`), when it has some that parses. */
  markup?: FigureMarkup;
  /** The footnote references right after the image, drawn at the end of its caption. */
  notes: FootnoteReference[];
}

/**
 * A `:::figure` that parses (tempra-dev: app/media, Figure markup): its width, placement and frame,
 * and its images, each a figure of its own in the numbering (the full-screen view steps through
 * them), drawn together with one caption when there are several.
 */
export interface FigureMarkup {
  node: ContainerDirective;
  spec: FigureSpec;
  figures: ImageFigure[];
}

export interface DiagramFigure extends FigureBase {
  kind: "diagram";
  node: Code;
  /** The fence's source. */
  source: string;
  /** For a chart, where its data comes from (TEMPRA-207). */
  chart?: ChartSource;
}

export interface Prepared {
  tree: Doc;
  /** The document's text, for comment anchors and the diff. */
  text: DocText;
  options: BodyOptions;
  /** Where each textblock (paragraph, heading, code, table cell) starts in `text`. */
  starts: Map<DocNode, number>;
  /** Each heading's anchor. */
  anchors: Map<DocNode, string>;
  headings: Heading[];
  /** Each footnote reference's link and marker. */
  markers: Map<DocNode, { href: string | null; mark: string }>;
  footnotes: Footnote[];
  /** The body's figures, in document order (figure n is `figures[n - 1]`). */
  figures: Figure[];
  /** Each figure by its paragraph or fence, and an image figure by its image too. */
  figureOf: Map<DocNode, Figure>;
  /** Each `:::figure` that parses, by its directive. */
  markup: Map<DocNode, FigureMarkup>;
}

/** The textblocks of a document in the order {@link docText} reads them. */
function textblocks(doc: Doc): DocNode[] {
  const out: DocNode[] = [];
  const visit = (n: DocNode) => {
    switch (n.type) {
      case "footnoteDefinition":
        return;
      case "paragraph":
        if (!isDirectiveLabel(n)) out.push(n);
        return;
      case "heading":
      case "code":
        out.push(n);
        return;
      case "table":
        for (const row of n.children) for (const cell of row.children) out.push(cell);
        return;
      default:
        if ("children" in n) for (const c of n.children as Nodes[]) visit(c);
    }
  };
  visit(doc);
  return out;
}

export function prepare(tree: Doc, options: BodyOptions = {}): Prepared {
  const text = docText(tree);
  const starts = new Map<DocNode, number>();
  const blocks = textblocks(tree);
  blocks.forEach((n, i) => {
    const tb = text.blocks[i];
    if (tb) starts.set(n, tb.from);
  });

  const footnotes: Footnote[] = [];
  const defined = new Set<string>();
  walk(tree, (n) => {
    if (n.type === "footnoteDefinition") {
      defined.add(n.label ?? n.identifier);
      footnotes.push({ label: n.label ?? n.identifier, identifier: n.identifier, node: n });
      return false;
    }
    return undefined;
  });

  const anchors = new Map<DocNode, string>();
  const headings: Heading[] = [];
  const anchor = slugger();
  const markers = new Map<DocNode, { href: string | null; mark: string }>();
  const marker = (n: DocNode) => {
    if (n.type !== "footnoteReference") return;
    const label = n.label ?? n.identifier;
    const has = defined.has(label);
    const ref = options.footnote
      ? options.footnote(label, has)
      : has
        ? { href: `#fn-${label}`, mark: `[${label}]` }
        : null;
    markers.set(n, ref ?? { href: null, mark: `[${label}]` });
  };
  // The body first, in reading order, then the definitions: markers are numbered as they are met.
  walk(tree, (n) => {
    if (n.type === "footnoteDefinition") return false;
    if (n.type === "heading") {
      const t = headingText(n.children);
      const id = anchor(t);
      anchors.set(n, id);
      headings.push({ depth: n.depth, text: t, id, first: tree.children[0] === n });
    }
    marker(n);
    return undefined;
  });
  for (const f of footnotes) walk(f.node, (n) => void marker(n));

  // Figures, in document order, by the rule the Worker numbers them by too (findFigures).
  // Figure markup (`:::figure`) that parses gathers its images, each a figure of its own.
  const figures: Figure[] = [];
  const figureOf = new Map<DocNode, Figure>();
  const markup = new Map<DocNode, FigureMarkup>();
  for (const found of findFigures(tree)) {
    if (found.kind === "image") {
      const { image } = found;
      const target = linkTarget(options.path ?? "", image.url);
      const f: ImageFigure = {
        n: found.n,
        kind: "image",
        caption: image.title?.trim() || image.alt?.trim() || null,
        node: found.node,
        image,
        url: image.url,
        alt: image.alt ?? "",
        src: null,
        source: imageSource(options, image.url),
        path: target?.kind === "internal" ? target.path : null,
        host: externalHost(image.url),
        notes: found.notes,
      };
      f.src = f.source?.src ?? null;
      figures.push(f);
      figureOf.set(image, f);
      if (found.markup) {
        const { node, spec } = found.markup;
        let m = markup.get(node);
        if (!m) {
          m = { node, spec, figures: [] };
          markup.set(node, m);
        }
        f.markup = m;
        m.figures.push(f);
      } else figureOf.set(found.node, f);
    } else {
      const f: DiagramFigure = {
        n: found.n,
        kind: "diagram",
        caption: fenceTitle(found.node.meta),
        node: found.node,
        source: found.node.value,
        ...(found.node.lang?.toLowerCase() === "vega-lite" && options.fileText
          ? { chart: { path: options.path ?? "", read: options.fileText } }
          : {}),
      };
      figures.push(f);
      figureOf.set(found.node, f);
    }
  }
  // One image under a label: the label is its caption.
  for (const m of markup.values()) {
    const only = m.figures.length === 1 ? m.figures[0] : undefined;
    if (only && m.spec.label) {
      only.caption = headingText(m.spec.label.children).trim() || only.caption;
    }
  }
  return {
    tree,
    text,
    options,
    starts,
    anchors,
    headings,
    markers,
    footnotes,
    figures,
    figureOf,
    markup,
  };
}

/** Where a link written in the body points, as the reader draws it. */
interface LinkInfo {
  /** Null for a target a browser must not follow (`javascript:`, `data:`), or one dropped. */
  href: string | null;
  /** The library path it resolves to, if it is internal. */
  path: string | null;
  broken: boolean;
}

export function linkInfo(options: BodyOptions, url: string): LinkInfo {
  const target = linkTarget(options.path ?? "", url);
  const path = target?.kind === "internal" ? target.path : null;
  const broken =
    target?.kind === "internal" && options.exists
      ? !options.exists(target.path, target.dir)
      : false;
  const href = options.href
    ? options.href(target, url, "link")
    : target && target.kind !== "internal"
      ? target.href
      : null;
  return { href, path, broken };
}

/**
 * The site an image written in the body is hotlinked from (an http(s) or scheme-relative URL), as
 * its host ("example.com", a `www.` dropped); null for the library's own files (TEMPRA-163).
 */
export function externalHost(url: string): string | null {
  const t = url.trim();
  if (!/^(https?:)?\/\//i.test(t)) return null;
  try {
    const host = new URL(t, "https://x.invalid").hostname;
    return host ? host.replace(/^www\./i, "") : null;
  } catch {
    return null;
  }
}

/** Where an image written in the body loads from, or null to show its alt text instead. */
function imageSrc(options: BodyOptions, url: string): string | null {
  const target = linkTarget(options.path ?? "", url);
  if (options.href) return options.href(target, url, "image");
  return target && target.kind !== "internal" ? target.href : null;
}

/** Where an image loads from with what the library knows of it (`image`), else as `imageSrc`. */
export function imageSource(options: BodyOptions, url: string): ImageSource | null {
  const target = linkTarget(options.path ?? "", url);
  if (target?.kind === "internal" && !target.dir && options.image) {
    const known = options.image(target.path);
    if (known) return known;
  }
  const src = imageSrc(options, url);
  return src === null ? null : { src };
}
