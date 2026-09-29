import type { Nodes, Root } from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFootnoteFromMarkdown } from "mdast-util-gfm-footnote";
import { gfmFootnote } from "micromark-extension-gfm-footnote";
import { isExternal, resolveLinkPath, safeDecode, splitAnchor } from "./paths";

/** A bundle-internal link in a concept body, located by the offsets of its target text. */
export interface BodyLink {
  /** Offset of the target (the `dest` in `[text](dest)`) in the body. */
  start: number;
  end: number;
  /** The target exactly as written, anchor included. */
  raw: string;
  /** The bundle path the target resolved to when written, without anchor. */
  path: string;
  anchor: string | null;
  form: "absolute" | "relative";
}

export interface BodyScan {
  links: BodyLink[];
  /**
   * Footnote labels referenced in the body (`[^label]`), in order of first use, whether or not the
   * body has a `[^label]: …` definition line for them.
   */
  footnoteRefs: string[];
  /** How many times each label is referenced. */
  footnoteCounts: Map<string, number>;
  /** Labels with a `[^label]: …` definition line. */
  footnoteDefs: string[];
}

/** A `[^label]` in text: GFM leaves a reference without a definition as literal text. */
const LITERAL_REF = /(?<!\\)\[\^([^\]\s]+)\](?!:)/g;

export function parseMarkdown(body: string): Root {
  return fromMarkdown(body, {
    extensions: [gfmFootnote()],
    mdastExtensions: [gfmFootnoteFromMarkdown()],
  });
}

/**
 * Finds internal links and footnote references in a body written at `conceptPath`. Uses a real
 * markdown parser so links inside code spans and fences are left alone.
 */
export function scanBody(body: string, conceptPath: string): BodyScan {
  const links: BodyLink[] = [];
  const refs: string[] = [];
  const counts = new Map<string, number>();
  const defs: string[] = [];
  const cite = (label: string) => {
    if (!counts.has(label)) refs.push(label);
    counts.set(label, (counts.get(label) ?? 0) + 1);
  };

  const visit = (node: Nodes) => {
    if (node.type === "footnoteReference") cite(node.label ?? node.identifier);
    if (node.type === "footnoteDefinition") defs.push(node.label ?? node.identifier);
    if (node.type === "text") {
      // Read the source, not the value, so an escaped `\[^x]` is not taken for a reference.
      const raw = body.slice(node.position?.start.offset ?? 0, node.position?.end.offset ?? 0);
      for (const m of raw.matchAll(LITERAL_REF)) cite(m[1] ?? "");
    }
    if (node.type === "link" || node.type === "image" || node.type === "definition") {
      const start = node.position?.start.offset;
      const end = node.position?.end.offset;
      if (start !== undefined && end !== undefined) {
        const span =
          node.type === "definition"
            ? definitionTarget(body, start, end)
            : inlineTarget(body, start, end);
        if (span) {
          const link = toLink(body, span, conceptPath);
          if (link) links.push(link);
        }
      }
    }
    if ("children" in node) for (const child of node.children) visit(child);
  };
  visit(parseMarkdown(body));
  links.sort((a, b) => a.start - b.start);
  return { links, footnoteRefs: refs, footnoteCounts: counts, footnoteDefs: defs };
}

function toLink(
  body: string,
  span: { start: number; end: number },
  conceptPath: string,
): BodyLink | null {
  const raw = body.slice(span.start, span.end);
  const target = raw.startsWith("<") && raw.endsWith(">") ? raw.slice(1, -1) : raw;
  if (target === "" || target.startsWith("#") || isExternal(target)) return null;
  const { path, anchor } = splitAnchor(target);
  if (path === "") return null;
  const resolved = resolveLinkPath(conceptPath, safeDecode(path));
  if (!resolved) return null;
  return {
    start: span.start,
    end: span.end,
    raw,
    path: resolved,
    anchor,
    form: path.startsWith("/") ? "absolute" : "relative",
  };
}

/** Skips a backtick code span starting at `i`; returns the index after it, or i + run length. */
function skipCode(s: string, i: number, end: number): number {
  let run = 0;
  while (i + run < end && s[i + run] === "`") run++;
  const fence = "`".repeat(run);
  const close = s.indexOf(fence, i + run);
  return close === -1 || close >= end ? i + run : close + run;
}

/** Index just past the `]` that closes the `[` at `open`, or -1. */
function closeBracket(s: string, open: number, end: number): number {
  let depth = 0;
  let i = open;
  while (i < end) {
    const c = s[i];
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (c === "`") {
      i = skipCode(s, i, end);
      continue;
    }
    if (c === "[") depth++;
    else if (c === "]") {
      depth--;
      if (depth === 0) return i + 1;
    }
    i++;
  }
  return -1;
}

/** The destination span of `[text](dest "title")` or `![alt](dest)` between start and end. */
function inlineTarget(s: string, start: number, end: number) {
  if (s[end - 1] !== ")") return null; // autolinks and reference links have no inline target
  const open = s.indexOf("[", start);
  if (open === -1 || open >= end) return null;
  const close = closeBracket(s, open, end);
  if (close === -1 || s[close] !== "(") return null;
  return destination(s, close + 1, end);
}

/** The destination span of a `[label]: dest "title"` definition. */
function definitionTarget(s: string, start: number, end: number) {
  const close = closeBracket(s, start, end);
  if (close === -1 || s[close] !== ":") return null;
  return destination(s, close + 1, end);
}

function destination(s: string, from: number, end: number) {
  let i = from;
  while (i < end && /\s/.test(s[i] ?? "")) i++;
  if (s[i] === "<") {
    const gt = s.indexOf(">", i);
    return gt === -1 || gt >= end ? null : { start: i, end: gt + 1 };
  }
  const begin = i;
  let depth = 0;
  while (i < end) {
    const c = s[i] ?? "";
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (/\s/.test(c)) break;
    if (c === "(") depth++;
    if (c === ")") {
      if (depth === 0) break;
      depth--;
    }
    i++;
  }
  return i === begin ? null : { start: begin, end: i };
}

/**
 * Body sections under a top-level heading with the given text (e.g. "Citations"): returns the
 * offsets of the heading line through the end of the section.
 */
export function findSection(body: string, heading: string): { start: number; end: number } | null {
  const root = parseMarkdown(body);
  let start = -1;
  let depth = 0;
  for (const node of root.children) {
    if (node.type !== "heading") continue;
    const off = node.position?.start.offset ?? 0;
    const text = body
      .slice(off, node.position?.end.offset)
      .replace(/^#+\s*/, "")
      .trim();
    if (start === -1 && text.toLowerCase() === heading.toLowerCase()) {
      start = off;
      depth = node.depth;
    } else if (start !== -1 && node.depth <= depth) {
      return { start, end: off };
    }
  }
  return start === -1 ? null : { start, end: body.length };
}
