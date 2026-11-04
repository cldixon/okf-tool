/**
 * What the full-screen view of a page's figures (Lightbox.svelte) is given and says beyond
 * the figure: the page's title, an image's facts, its file page and download.
 */
import { formatSize, relativeTime } from "../ui";
import { baseName } from "../urls";
import type { ImageFigure } from "./prepare";

/** What the page knows about an image in the library, for the line under it. All optional. */
export interface ImageFacts {
  /** Its size in bytes. */
  size?: number | null;
  /** Its media type. */
  media?: string | null;
  /** Who added the current version (a name or handle as the page shows people). */
  by?: string | null;
  /** When, as an ISO 8601 datetime. */
  at?: string | null;
  /** The host it was fetched from, when an agent attached it from a URL (TEMPRA-170). */
  host?: string | null;
  /** What it shows, in its writer's words. */
  description?: string | null;
}

/** What the reader's page gives the full-screen view. Without it the view still works. */
export interface FigureView {
  /** The page's title, shown in the view's header before "Figure n of m". */
  title?: string;
  /** Facts about an image at a library path, loaded when the view shows it. */
  describe?(path: string): Promise<ImageFacts | null>;
  /** The page of an image stored in the library (its attachment page), for Open file. */
  fileHref?(path: string): string;
  /** The original of an image stored in the library, as a download, for Download. */
  downloadHref?(path: string): string;
}

/**
 * An image figure's quiet line: its file name (or URL), size, the host it came from, who added it
 * and when, and what it shows.
 */
export function factsLine(f: ImageFigure, facts: ImageFacts | null): string {
  const parts = [f.path ? baseName(f.path) : f.url];
  if (facts?.size != null) parts.push(formatSize(facts.size));
  if (facts?.host) parts.push(`from ${facts.host}`);
  if (facts?.by) parts.push(`added by ${facts.by}${facts.at ? `, ${relativeTime(facts.at)}` : ""}`);
  if (facts?.description) parts.push(facts.description);
  return parts.join(" · ");
}
