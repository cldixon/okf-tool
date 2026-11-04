/**
 * What an attachment's page says about the file (TEMPRA-170, tempra-dev: app/media, The image's
 * page), as Wikipedia's File: pages do: what it shows, where it came from, who made it and under
 * what licence, every version, and where it is used. Pure helpers; the parts are SourceFact,
 * UsedIn and FileHistory (.svelte), and the page (`File.svelte`) loads the data.
 */
import { resolveLinkPath } from "@tempra/editor";
import type { ActedBy, ActorView } from "../agents";
import { type AttachSource, actedBy, type FileJson, type HistoryEvent } from "../page/data";
import { prepare } from "../reader/prepare";
import { formatSize } from "../ui";

type PageFile = Extract<FileJson, { kind: "page" }>;

/** A page that uses the file: the figures it appears as, and the source entry citing it. */
export interface Use {
  path: string;
  /** Each figure showing this file: its number, caption (if any) and alt text. */
  figures: { n: number; caption: string | null; alt: string }[];
  /** The page's `sources` entry for the file (its title, else its resource), when it has one. */
  cites: string | null;
}

/** The host of a URL, without a leading `www.`; the URL itself when it does not parse. */
export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/**
 * How a page uses the file at `file`: the figures (by the reader's numbering, so "Figure 3" is
 * the one a person sees) whose image is that file, and the source entry that names the URL it
 * was fetched from (or the file's own path).
 */
export function figureUse(
  file: string,
  page: PageFile,
  source: AttachSource | null | undefined,
): Use {
  const prepared = prepare(page.doc, { path: page.path });
  const figures = prepared.figures.flatMap((f) =>
    f.kind === "image" && f.path === file ? [{ n: f.n, caption: f.caption, alt: f.alt }] : [],
  );
  const urls = new Set([source?.url, source?.final_url].filter((u): u is string => !!u));
  const list = page.frontmatter.sources;
  let cites: string | null = null;
  for (const s of Array.isArray(list) ? list : []) {
    if (!s || typeof s !== "object" || Array.isArray(s)) continue;
    const resource = typeof s.resource === "string" ? s.resource.trim() : "";
    if (!resource) continue;
    const internal = resource.startsWith("/") ? resolveLinkPath("", resource) : null;
    if (urls.has(resource) || internal === file) {
      cites = typeof s.title === "string" && s.title.trim() ? s.title.trim() : resource;
      break;
    }
  }
  return { path: page.path, figures, cites };
}

/**
 * What the file shows: its own description, else the alt text of the first figure that uses it
 * (marked as such, since a figure's alt was written for that page, not for the file).
 */
export function describedAs(
  description: string | null | undefined,
  uses: readonly Use[] | null,
): { text: string; fromAlt: boolean } | null {
  if (description) return { text: description, fromAlt: false };
  for (const u of uses ?? []) {
    for (const f of u.figures) if (f.alt.trim()) return { text: f.alt.trim(), fromAlt: true };
  }
  return null;
}

/** One version of the file, as File history lists it. */
export interface Version {
  seq: number;
  ts: string;
  actor: string;
  by: ActedBy | null;
  /** "Added", "Replaced", or "Details changed" (the same bytes, a new description or type). */
  what: "Added" | "Replaced" | "Details changed";
  size: number | null;
  width: number | null;
  height: number | null;
  /** The version shown on the page (the newest, or the one the page is pinned to). */
  current: boolean;
}

const VERSION_OPS = new Set(["put", "import", "revert"]);

/**
 * Every version of the file from its history, newest first; the newest at or before `at` (the
 * version on screen) is current.
 */
export function versionsOf(events: readonly HistoryEvent[], at: number): Version[] {
  const out: Version[] = [];
  let first = true;
  for (const e of events) {
    if (e.op === "delete") first = true;
    if (!VERSION_OPS.has(e.op) || e.hash === null) continue;
    out.push({
      seq: e.seq,
      ts: e.ts,
      actor: e.actor,
      by: actedBy(e),
      what: first ? "Added" : e.prev_hash === e.hash ? "Details changed" : "Replaced",
      size: e.file?.size ?? null,
      width: e.file?.width ?? null,
      height: e.file?.height ?? null,
      current: false,
    });
    first = false;
  }
  out.reverse();
  const current = out.find((v) => v.seq <= at);
  if (current) current.current = true;
  return out;
}

/** "1.2 MB · 2400 × 1500", as much of it as is known. */
export function sizeText(size: number | null, width?: number | null, height?: number | null) {
  const parts: string[] = [];
  if (size !== null) parts.push(formatSize(size));
  if (width && height) parts.push(`${width} × ${height}`);
  return parts.join(" · ");
}

/** Names who acted, for the attachment page's parts. */
export type Name = (actor: string, by: ActedBy | null) => ActorView;
