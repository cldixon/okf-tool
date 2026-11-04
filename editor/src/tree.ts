/**
 * The stored form of a concept body (tempra-dev: decisions/structured-documents): an mdast tree
 * (GFM and footnotes) without source positions, with an `id` on every block. Markdown is parsed
 * into it and generated from it here, by the one parser the Worker and the app share. No Wordgard,
 * no DOM.
 */
import type { Nodes, Parent, Root, RootContent, Text } from "mdast";
import { directiveFromMarkdown, directiveToMarkdown } from "mdast-util-directive";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown, gfmToMarkdown } from "mdast-util-gfm";
import { toMarkdown as write } from "mdast-util-to-markdown";
import { directive } from "micromark-extension-directive";
import { gfm } from "micromark-extension-gfm";
import { canonicalDirective, isDirectiveLabel } from "./figure";

/** A concept body: the root of the tree. Every block in it carries an `id`. */
export type Doc = Root;

/** Any node of a document. */
export type DocNode = Nodes;

/** A block at the top of a document. */
export type Block = RootContent;

/** Block containers: their children are blocks with IDs. Tables, rows and cells are not. */
const CONTAINERS = new Set([
  "root",
  "blockquote",
  "list",
  "listItem",
  "footnoteDefinition",
  "containerDirective",
]);

/** The block children of a node (empty for a leaf block or inline content). */
export function blocksOf(node: DocNode): RootContent[] {
  return CONTAINERS.has(node.type) ? ((node as Parent).children as RootContent[]) : [];
}

/** A block's ID, if it has one. */
export function idOf(node: DocNode): string | undefined {
  return (node as { id?: string }).id;
}

export function setId(node: DocNode, id: string): void {
  (node as { id?: string }).id = id;
}

/** A node as JSON without IDs: equal signatures mean equal content. */
export function signature(node: DocNode): string {
  return JSON.stringify(node, (k, v) => (k === "id" ? undefined : v));
}

/**
 * Directives (tempra-dev: app/media, Figure markup): the container form (`:::name[label]{…}`) only.
 * Text (`:name`) and leaf (`::name`) directives stay off, so prose like `ratio 3:1` or `see:here`
 * never changes meaning.
 */
const containerDirectives = (() => {
  const flow = (directive().flow?.[58] ?? []) as { concrete?: boolean }[];
  return { flow: { 58: flow.filter((c) => c.concrete) } };
})();

/**
 * Writing container directives: attributes unquoted where they can be (`{width=480 frame}`), and
 * none of the package's escapes for text directives (which are off), so `see:here` stays as it is.
 * A line of text that would open a directive (`:::x`) is escaped (`::\:x`) so it stays text.
 */
const directiveOut = (() => {
  const d = directiveToMarkdown({ preferUnquoted: true });
  return {
    handlers: { containerDirective: d.handlers?.containerDirective },
    unsafe: [
      { character: "\r", inConstruct: ["containerDirectiveLabel"] },
      { character: "\n", inConstruct: ["containerDirectiveLabel"] },
      { atBreak: true, before: "::", character: ":" },
    ],
  };
})();

/** The canonical markdown: ATX headings, `-` bullets, `*` emphasis, fenced code, `---` rules. */
const OPTIONS = {
  extensions: [gfmToMarkdown(), directiveOut],
  bullet: "-",
  emphasis: "*",
  strong: "*",
  fence: "`",
  fences: true,
  rule: "-",
  listItemIndent: "one",
  setext: false,
} as const;

/**
 * Parses markdown (a body, without frontmatter) into a document without IDs: positions dropped,
 * and a `[^label]` the parser left as text (no definition in the body; pages cite `sources[].id`)
 * made a footnote reference, so it is written back as written.
 */
export function parseMarkdown(markdown: string): Doc {
  const tree = fromMarkdown(markdown, {
    extensions: [gfm(), containerDirectives as never],
    mdastExtensions: [gfmFromMarkdown(), directiveFromMarkdown()],
  });
  const clean = (node: DocNode) => {
    delete node.position;
    // A directive's label is the one node that keeps its data (mdast-util-directive's mark).
    if (isDirectiveLabel(node)) node.data = { directiveLabel: true } as never;
    else delete node.data;
    if (!("children" in node)) return;
    const out: DocNode[] = [];
    for (const child of node.children as DocNode[]) {
      if (child.type === "text") out.push(...footnoteRefs(child, markdown));
      else out.push(child);
      clean(child);
    }
    (node as Parent).children = out as Parent["children"];
    if (node.type === "containerDirective") canonicalDirective(node);
  };
  clean(tree);
  return tree;
}

/** A `[^label]` in text that is not a definition. */
const LITERAL_REF = /\[\^([^\]\s]+)\](?!:)/g;

/**
 * A text node split around the literal footnote references written in its source. Each one in the
 * value is found in the source, in order (escapes only add characters); one written escaped
 * (`\[^x]`), or not found as written (an entity), stays text.
 */
function footnoteRefs(node: Text, src: string): DocNode[] {
  if (!node.value.includes("[^")) return [node];
  const to = node.position?.end.offset ?? 0;
  let cursor = node.position?.start.offset ?? 0;
  const out: DocNode[] = [];
  let pos = 0;
  for (const m of node.value.matchAll(LITERAL_REF)) {
    const at = src.indexOf(m[0], cursor);
    if (at === -1 || at + m[0].length > to) break;
    cursor = at + m[0].length;
    if (src[at - 1] === "\\") continue;
    const label = m[1] ?? "";
    if (m.index > pos) out.push({ type: "text", value: node.value.slice(pos, m.index) });
    out.push({ type: "footnoteReference", identifier: label.toLowerCase(), label });
    pos = m.index + m[0].length;
  }
  if (pos === 0) return [node];
  if (pos < node.value.length) out.push({ type: "text", value: node.value.slice(pos) });
  return out;
}

/** Writes a document as canonical markdown. Deterministic: the same tree gives the same bytes. */
export function toMarkdown(doc: Doc): string {
  return doc.children.length === 0 ? "" : write(doc, OPTIONS as never);
}

/** Markdown in its canonical form: what a body reads back as once stored. */
export function normalize(markdown: string): string {
  return toMarkdown(parseMarkdown(markdown));
}

/** Every node of a document, depth first, with `fn` returning false to skip a node's children. */
export function walk(node: DocNode, fn: (node: DocNode) => boolean | undefined): void {
  if (fn(node) === false) return;
  if ("children" in node) for (const child of node.children as DocNode[]) walk(child, fn);
}
