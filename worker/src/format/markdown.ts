import { type Doc, type DocNode, walk } from "@tempra/editor/doc";
import type { Heading, RootContent } from "mdast";
import { isExternal, resolveLinkPath, safeDecode, splitAnchor } from "./paths";

/** A bundle-internal link in a page body: a link, image or definition, in document order. */
export interface BodyLink {
  /** Which of the document's {@link targets} it is. */
  at: number;
  /** The target exactly as written, anchor included. */
  raw: string;
  /** The bundle path the target resolved to when written, without anchor. */
  path: string;
  anchor: string | null;
  form: "absolute" | "relative";
}

export interface BodyScan {
  links: BodyLink[];
  /** Footnote labels referenced in the body (`[^label]`), in order of first use. */
  footnoteRefs: string[];
  /** How many times each label is referenced. */
  footnoteCounts: Map<string, number>;
  /** Labels with a `[^label]: …` definition. */
  footnoteDefs: string[];
}

/** The nodes that carry a link target: links, images and definitions. */
export type TargetNode = Extract<DocNode, { url: string }>;

/** Every node carrying a link target, in document order. */
export function targets(doc: Doc): TargetNode[] {
  const out: TargetNode[] = [];
  walk(doc, (n) => {
    if (n.type === "link" || n.type === "image" || n.type === "definition") out.push(n);
    return undefined;
  });
  return out;
}

/** Finds internal links and footnote references in a body written at `pagePath`. */
export function scanDoc(doc: Doc, pagePath: string): BodyScan {
  const refs: string[] = [];
  const counts = new Map<string, number>();
  const defs: string[] = [];
  walk(doc, (n) => {
    if (n.type === "footnoteReference") {
      const label = n.label ?? n.identifier;
      if (!counts.has(label)) refs.push(label);
      counts.set(label, (counts.get(label) ?? 0) + 1);
    }
    if (n.type === "footnoteDefinition") defs.push(n.label ?? n.identifier);
    return undefined;
  });
  const links = targets(doc).flatMap((n, at) => {
    const link = toLink(n.url, pagePath);
    return link ? [{ at, ...link }] : [];
  });
  return { links, footnoteRefs: refs, footnoteCounts: counts, footnoteDefs: defs };
}

/** A link target as an internal link, or null for an external one, an anchor or nothing. */
export function toLink(raw: string, pagePath: string): Omit<BodyLink, "at"> | null {
  if (raw === "" || raw.startsWith("#") || isExternal(raw)) return null;
  const { path, anchor } = splitAnchor(raw);
  if (path === "") return null;
  const resolved = resolveLinkPath(pagePath, safeDecode(path));
  if (!resolved) return null;
  return { raw, path: resolved, anchor, form: path.startsWith("/") ? "absolute" : "relative" };
}

/**
 * Takes the section under a top-level heading with the given text (e.g. "Citations") out of a
 * document: the heading through the next heading as deep or deeper. Returns it, or null.
 */
export function takeSection(doc: Doc, heading: string): RootContent[] | null {
  const text = (h: Heading) =>
    h.children
      .map((c) => ("value" in c ? c.value : ""))
      .join("")
      .trim()
      .toLowerCase();
  const start = doc.children.findIndex(
    (n) => n.type === "heading" && text(n) === heading.toLowerCase(),
  );
  if (start === -1) return null;
  const depth = (doc.children[start] as Heading).depth;
  let end = start + 1;
  while (end < doc.children.length) {
    const n = doc.children[end] as RootContent;
    if (n.type === "heading" && n.depth <= depth) break;
    end++;
  }
  return doc.children.splice(start, end - start);
}
