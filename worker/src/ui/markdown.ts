import type { Element, ElementContent, Nodes as HastNodes, Root as HastRoot } from "hast";
import { toHtml } from "hast-util-to-html";
import type { Nodes, Root } from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { type Handlers, toHast } from "mdast-util-to-hast";
import { gfm } from "micromark-extension-gfm";
import { isExternal, resolveLinkPath, safeDecode, splitAnchor } from "../okf/paths";

/** Where a link or image in a concept body points. */
export type LinkTarget =
  | { kind: "external"; href: string }
  | { kind: "anchor"; href: string }
  /** A path in the library; `dir` when written with a trailing slash. */
  | { kind: "internal"; path: string; anchor: string | null; dir: boolean };

const SAFE_SCHEMES = /^(?:https?:|mailto:)/i;

/**
 * Classifies a link target written in the concept at `conceptPath`. Returns null for schemes a
 * browser must not follow from agent-written content (javascript:, data:, and so on).
 */
export function linkTarget(conceptPath: string, target: string): LinkTarget | null {
  const t = target.trim();
  if (t === "") return null;
  if (t.startsWith("#")) return { kind: "anchor", href: t };
  if (t.startsWith("//")) return { kind: "external", href: `https:${t}` };
  if (isExternal(t)) return SAFE_SCHEMES.test(t) ? { kind: "external", href: t } : null;
  const { path, anchor } = splitAnchor(t);
  const resolved = resolveLinkPath(conceptPath, safeDecode(path));
  if (resolved === null) {
    // A link to the bundle root ("/" or "../" from the top level).
    return /^[./]*$/.test(path) ? { kind: "internal", path: "", anchor, dir: true } : null;
  }
  return { kind: "internal", path: resolved, anchor, dir: path.endsWith("/") };
}

export interface BodyOptions {
  /** The URL for a link or image target, or null to drop it. */
  url(target: string, kind: "link" | "image"): string | null;
  /**
   * The href a footnote reference with this label points to, or null when it cites nothing.
   * `defined` says whether the body has a `[^label]: …` definition for it.
   */
  footnote(label: string, defined: boolean): string | null;
}

export interface RenderedBody {
  html: string;
  /** Footnote definitions by label, each rendered to HTML. */
  footnotes: Map<string, string>;
}

function parse(body: string): Root {
  return fromMarkdown(body, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] });
}

/** Lowercase, hyphenated heading text, as GitHub and most renderers anchor headings. */
export function slug(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/\s+/g, "-");
}

function textOf(node: HastNodes): string {
  if (node.type === "text") return node.value;
  if ("children" in node) return node.children.map((c) => textOf(c as HastNodes)).join("");
  return "";
}

/**
 * Renders a concept body to HTML for the built-in UI. Raw HTML in the markdown is shown as text,
 * never rendered; link and image URLs go through `opts.url`; footnote references become links to
 * the cited source, and footnote definitions are returned separately for the sources panel.
 */
export function renderBody(body: string, opts: BodyOptions): RenderedBody {
  const tree = parse(body);
  const footnotes = new Map<string, string>();
  const handlers: Handlers = {
    // Shown, not rendered: agent-written content must not inject markup.
    html: (_state, node) => ({
      type: "element",
      tagName: "code",
      properties: { className: ["raw-html"] },
      children: [{ type: "text", value: node.value }],
    }),
    footnoteReference: (_state, node) => {
      const label = node.label ?? node.identifier;
      const href = opts.footnote(label, footnotes.has(label) || defined.has(label));
      const text: ElementContent = { type: "text", value: `[${label}]` };
      return {
        type: "element",
        tagName: "sup",
        properties: { className: ["fnref"] },
        children: href
          ? [{ type: "element", tagName: "a", properties: { href }, children: [text] }]
          : [text],
      };
    },
    footnoteDefinition: () => undefined,
  };

  const defined = new Set<string>();
  const find = (node: Nodes) => {
    if (node.type === "footnoteDefinition") defined.add(node.label ?? node.identifier);
    if ("children" in node) for (const child of node.children) find(child);
  };
  find(tree);
  const collect = (node: Nodes) => {
    if (node.type === "footnoteDefinition") {
      const root: Root = { type: "root", children: node.children };
      footnotes.set(node.label ?? node.identifier, finish(toHast(root, { handlers }), opts));
      return;
    }
    if ("children" in node) for (const child of node.children) collect(child);
  };
  collect(tree);

  return { html: finish(toHast(tree, { handlers }), opts, new Map()), footnotes };
}

/** Rewrites URLs, adds heading anchors, and serializes. */
function finish(tree: HastNodes, opts: BodyOptions, slugs?: Map<string, number>): string {
  const visit = (node: HastNodes) => {
    if (node.type === "element") fixElement(node, opts, slugs);
    if ("children" in node) for (const child of node.children) visit(child as HastNodes);
  };
  visit(tree);
  return toHtml(tree as HastRoot);
}

function fixElement(el: Element, opts: BodyOptions, slugs?: Map<string, number>) {
  const p = el.properties;
  if (el.tagName === "a" && typeof p.href === "string") {
    const href = opts.url(p.href, "link");
    if (href === null) delete p.href;
    else {
      p.href = href;
      if (/^(?:https?:)?\/\//i.test(href)) p.rel = ["noopener", "noreferrer", "nofollow"];
    }
  }
  if (el.tagName === "img" && typeof p.src === "string") {
    const src = opts.url(p.src, "image");
    if (src === null) delete p.src;
    else p.src = src;
    p.loading = "lazy";
  }
  if (slugs && /^h[1-6]$/.test(el.tagName)) {
    const base = slug(textOf(el)) || "section";
    const n = slugs.get(base) ?? 0;
    slugs.set(base, n + 1);
    p.id = n === 0 ? base : `${base}-${n}`;
  }
}
