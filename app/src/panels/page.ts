/**
 * The page panel (tempra-dev: app/page-panel): an MCP App a host draws in the chat beside a `show`
 * call, one page drawn as the app draws it (the same reader, the design package's prose), to
 * read. Everything it draws comes in the tool's result (`structuredContent.page`,
 * worker/src/mcp/page.ts). This module is its pure part: what the result holds and how the
 * reader is told to draw links, images and footnote markers.
 */
import type { Doc, LinkTarget } from "@tempra/editor";
import { readableName } from "../agents";
import type { ImageRef, ImageSource } from "../images";
import { mediaKind } from "../images";
import type { BodyOptions } from "../reader/prepare";
import { anchorId } from "../ui";
import { folderName } from "../urls";

/** What `show` puts in `structuredContent.page`. */
export interface PagePayload {
  v: 1;
  library: { owner: string; slug: string };
  page: {
    path: string;
    seq: number;
    title: string;
    description: string | null;
    status: string | null;
    stale: boolean;
    doc: Doc;
    images: Record<string, ImageRef & { src: string | null }>;
  };
  sources: { id: string; title: string | null; resource: string | null }[];
  byline: { name: string; agent: boolean; at: string } | null;
}

/**
 * The byline's name as the app writes it: a person by handle, an agent in words for whom it acts
 * ("Claude Code for @dev", from "claude-code for @dev").
 */
export function bylineName(byline: NonNullable<PagePayload["byline"]>): string {
  if (!byline.agent) return byline.name;
  const m = / for (@\S+)$/.exec(byline.name);
  return m
    ? `${readableName(byline.name.slice(0, m.index))} for ${m[1]}`
    : readableName(byline.name);
}

/** The page in a tool result, when it holds one this panel can draw. */
export function pageFrom(result: { structuredContent?: unknown } | null | undefined) {
  const p = (result?.structuredContent as { page?: Partial<PagePayload> } | undefined)?.page;
  if (p?.v !== 1 || !p.page || typeof p.page.path !== "string" || !p.page.doc) {
    return null;
  }
  return p as PagePayload;
}

/** What the panel needs from its host (page-main.ts), so it can be tested without one. */
export interface PageHost {
  /** Hands the panel each page a tool result brings (null for one it cannot draw); returns how to stop. */
  subscribe(page: (p: PagePayload | null) => void): () => void;
  /** Opens a link in the person's browser; false when the host cannot. */
  openLink(url: string): Promise<boolean>;
}

/**
 * How the reader draws this page in the panel: web links as links (the panel opens them in the
 * browser), links to other library files as text, since the panel shows one page; images from
 * their signed links; footnote markers numbered by the sources' order, then the body's.
 */
export function bodyOptions(page: PagePayload): BodyOptions {
  const ids = page.sources.map((s) => s.id);
  const numbers = new Map<string, number>(ids.map((id, i) => [id, i + 1]));
  const sourceIds = new Set(ids);
  return {
    path: page.page.path,
    href: (t: LinkTarget | null, _raw: string, kind: "link" | "image") => {
      if (!t) return null;
      if (t.kind !== "internal") return t.href;
      if (kind === "image") return page.page.images[t.path]?.src ?? null;
      // A link within the page (a heading) still scrolls; one to another page is not followed.
      return t.path === page.page.path && t.anchor ? t.anchor : null;
    },
    image: (path) => {
      const ref = page.page.images[path];
      if (!ref?.src) return null;
      const out: ImageSource = { src: ref.src, kind: mediaKind(ref.media) };
      if (ref.width && ref.height) {
        out.width = ref.width;
        out.height = ref.height;
      }
      if (ref.size !== undefined) out.size = ref.size;
      if (out.kind === "pdf") out.download = ref.src;
      return out;
    },
    // A chart's data file needs the library; the panel shows such a chart as its source.
    fileText: async () => null,
    footnote: (label, defined) => {
      if (!sourceIds.has(label) && !defined) return null;
      if (!numbers.has(label)) numbers.set(label, numbers.size + 1);
      const prefix = sourceIds.has(label) ? "src" : "fn";
      return { href: `#${anchorId(prefix, label)}`, mark: String(numbers.get(label)) };
    },
  };
}

/** Where the page sits: the library, then its folders by their readable names, as the app has them. */
export function whereOf(page: PagePayload): string {
  const dirs = page.page.path.split("/").slice(0, -1);
  return [`${page.library.owner}/${page.library.slug}`, ...dirs.map(folderName)].join(" / ");
}
