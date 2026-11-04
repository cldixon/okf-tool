/**
 * Where a link in a page body points, and heading anchors. The same rules as the server's
 * (worker/src/format/paths.ts), so the reader and the server agree;
 * kept here, DOM-free, because the reader needs them in the browser.
 */
import type { PhrasingContent } from "mdast";
import { type Doc, type DocNode, walk } from "./tree";

/** Where a link or image target written in a page body points. */
export type LinkTarget =
  | { kind: "external"; href: string }
  | { kind: "anchor"; href: string }
  /** A path in the library; `dir` when written with a trailing slash. */
  | { kind: "internal"; path: string; anchor: string | null; dir: boolean };

const SAFE_SCHEMES = /^(?:https?:|mailto:)/i;

/**
 * Classifies a link target written in the page at `pagePath`. Returns null for schemes a
 * browser must not follow from agent-written content (javascript:, data:, and so on).
 */
export function linkTarget(pagePath: string, target: string): LinkTarget | null {
  const t = target.trim();
  if (t === "") return null;
  if (t.startsWith("#")) return { kind: "anchor", href: t };
  if (t.startsWith("//")) return { kind: "external", href: `https:${t}` };
  if (isExternal(t)) return SAFE_SCHEMES.test(t) ? { kind: "external", href: t } : null;
  const { path, anchor } = splitAnchor(t);
  const resolved = resolveLinkPath(pagePath, safeDecode(path));
  if (resolved === null) {
    // A link to the library root ("/" or "../" from the top level).
    return /^[./]*$/.test(path) ? { kind: "internal", path: "", anchor, dir: true } : null;
  }
  return { kind: "internal", path: resolved, anchor, dir: path.endsWith("/") };
}

/** True for targets that point outside the library (a URL scheme, `//host`, or `mailto:`). */
export function isExternal(target: string): boolean {
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(target) || target.startsWith("//");
}

/** Splits `path#anchor` (and drops any `?query`). */
export function splitAnchor(target: string): { path: string; anchor: string | null } {
  let t = target;
  let anchor: string | null = null;
  const hash = t.indexOf("#");
  if (hash !== -1) {
    anchor = t.slice(hash);
    t = t.slice(0, hash);
  }
  const q = t.indexOf("?");
  if (q !== -1) t = t.slice(0, q);
  return { path: t, anchor };
}

function safeDecode(s: string): string {
  try {
    return decodeURI(s);
  } catch {
    return s;
  }
}

function dirname(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? "" : path.slice(0, i);
}

/** Collapses `.` and `..`; null when the path escapes the root or is empty. */
export function normalizePath(path: string): string | null {
  const out: string[] = [];
  for (const seg of path.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (out.length === 0) return null;
      out.pop();
      continue;
    }
    out.push(seg);
  }
  return out.length === 0 ? null : out.join("/");
}

/** Absolute targets (leading `/`) are library-relative; others are relative to the page. */
export function resolveLinkPath(fromPath: string, target: string): string | null {
  if (target.startsWith("/")) return normalizePath(target);
  const dir = dirname(fromPath);
  return normalizePath(dir === "" ? target : `${dir}/${target}`);
}

/** Lowercase, hyphenated heading text, as GitHub and most renderers anchor headings. */
export function slug(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/\s+/g, "-");
}

/** Gives each heading a unique anchor: `intro`, `intro-1`, …; `section` when the text has none. */
export function slugger(): (text: string) => string {
  const seen = new Map<string, number>();
  return (text) => {
    const base = slug(text) || "section";
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return n === 0 ? base : `${base}-${n}`;
  };
}

/** A heading's text as its anchor is made from: footnote references as `[label]`, images by alt. */
export function headingText(nodes: readonly PhrasingContent[]): string {
  return nodes
    .map((n): string => {
      if (n.type === "text" || n.type === "inlineCode") return n.value;
      if (n.type === "footnoteReference") return `[${n.label ?? n.identifier}]`;
      if (n.type === "image") return n.alt ?? "";
      if ("children" in n) return headingText(n.children as PhrasingContent[]);
      return "";
    })
    .join("");
}

/** Every heading anchor of a document, as the reader gives them (footnote definitions aside). */
export function headingIds(doc: Doc): Set<string> {
  const anchor = slugger();
  const ids = new Set<string>();
  walk(doc, (n: DocNode) => {
    if (n.type === "footnoteDefinition") return false;
    if (n.type === "heading") {
      ids.add(anchor(headingText(n.children)));
      return false;
    }
    return undefined;
  });
  return ids;
}
