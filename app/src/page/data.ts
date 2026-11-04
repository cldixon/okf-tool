import type { Doc, LinkTarget } from "@tempra/editor";
import type { ActedBy } from "../agents";
import { api } from "../api";
import type { ImageRef } from "../images";
import { registerPage } from "../prefetch";
import { baseName, dirOf, enc, type Urls } from "../urls";
import type { ReadHistory } from "./reads";

/**
 * What a file's page loads (tempra-dev: app/reader): the file and, for a concept, everything its
 * page shows around the body: sources, links and versions, in one request (TEMPRA-191).
 */

export type Json = string | number | boolean | null | Json[] | { [k: string]: Json };
export type JsonObject = { [k: string]: Json };

export interface Source extends JsonObject {}

export interface Sources {
  sources: Source[];
  unmatched_footnotes: string[];
}

/** GET …/files/{path} as JSON: what each kind of file is. */
export type FileJson =
  | {
      kind: "concept";
      path: string;
      seq: number;
      hash: string;
      /** The body as stored: a tree, links at their targets' current paths. */
      doc: Doc;
      frontmatter: JsonObject;
      lint: { code: string; message: string }[];
      trust_tier: string;
      stale: boolean;
      /** Within 14 days of stale_after. */
      stale_soon?: boolean;
      /** The attachments its images show, by path: hash and size (TEMPRA-162). */
      images?: Record<string, ImageRef>;
    }
  | { kind: "derived"; path: string; seq: number; doc: Doc }
  | {
      kind: "attachment";
      path: string;
      seq: number;
      size: number;
      media: string | null;
      hash: string;
      /** An image's size in pixels, from its header (TEMPRA-152); null when not known. */
      width?: number | null;
      height?: number | null;
      /** Where the bytes were fetched from, when an agent attached them from a URL (TEMPRA-157). */
      source?: AttachSource | null;
      /** What the file shows, its credit and its licence, as its writer gave them (TEMPRA-170). */
      description?: string | null;
      credit?: string | null;
      licence?: string | null;
      /** The person who sent the bytes from an agent's upload link, by handle (TEMPRA-196). */
      supplied_by?: string | null;
      /** What this version was made from on the server, by an agent's `transform` (TEMPRA-208). */
      made_from?: MadeFrom | null;
      /** A video's poster, the image beside it as `<name>.poster.png` (TEMPRA-182). */
      poster?: ({ path: string } & ImageRef) | null;
      /** For a video's poster, the video's path (TEMPRA-182). */
      poster_for?: string | null;
    };

/** An attachment made from another: the file, the hash it had, and what was done. */
export interface MadeFrom {
  path: string;
  hash: string;
  op: string;
}

/** An attachment fetched from a URL: the URL, where it ended after redirects, and when. */
export interface AttachSource {
  via: "url";
  url: string;
  final_url?: string;
  fetched_at: string;
}

export type Concept = Extract<FileJson, { kind: "concept" }>;

export interface Links {
  inbound: { path: string; raw: string; kind: string }[];
  broken: { raw: string; path: string; kind: string }[];
}

export interface HistoryEvent {
  seq: number;
  ts: string;
  actor: string;
  op: string;
  path: string;
  hash: string | null;
  /** The hash before this event (null for the first). */
  prev_hash?: string | null;
  meta: JsonObject | null;
  /** An attachment version's bytes: size, type and dimensions (TEMPRA-170). */
  file?: { size: number; media: string | null; width: number | null; height: number | null };
}

/** The person and agent behind an event, as its meta keeps them (TEMPRA-75), if it does. */
export function actedBy(e: Pick<HistoryEvent, "meta">): ActedBy | null {
  const by = e.meta?.by;
  if (!by || typeof by !== "object" || Array.isArray(by) || typeof by.person !== "string") {
    return null;
  }
  return typeof by.agent === "string"
    ? { person: by.person, agent: by.agent }
    : { person: by.person };
}

/** What a concept's page shows around its body. */
export interface ConceptData {
  concept: Concept;
  sources: Sources;
  links: Links;
  history: HistoryEvent[];
  /** How much the page is read and how recently (TEMPRA-220); null when not known. */
  reads: ReadHistory | null;
}

/** What a file's page shows: the file, the head, and for a concept its context. */
export interface FileData {
  file: FileJson;
  head: number;
  extra: ConceptData | null;
}

/** Ops that change a file's content (or remove it), and so have a diff. */
export const CONTENT_OPS = new Set(["put", "import", "revert", "delete", "attach"]);

/** Whether a path can be a concept: markdown, and not a synthesized index.md or log.md. */
export const isConceptPath = (path: string) =>
  path.endsWith(".md") && !/(^|\/)(index|log)\.md$/.test(path);

/** The cache key of a file's page (see useLoad). */
export const fileKey = (urls: Urls, path: string) => `file ${urls.file(path)}`;

/** Where links and images in a body point in the app, as the server's plain pages did. */
export function bodyHref(urls: Urls) {
  return (t: LinkTarget | null, _raw: string, kind: "link" | "image"): string | null => {
    if (!t) return null;
    if (t.kind !== "internal") return t.href;
    if (t.dir || t.path === "") return urls.tree(t.path) + (t.anchor ?? "");
    if (baseName(t.path) === "index.md") return urls.tree(dirOf(t.path)) + (t.anchor ?? "");
    return kind === "image" ? urls.download(t.path) : urls.file(t.path, t.anchor);
  };
}

/** `GET …/page/{path}`: the file, the head, and for a concept what its page shows around it. */
type PageJson =
  | {
      file: Concept;
      head: number;
      sources: Sources;
      links: Links;
      history: { events: HistoryEvent[] };
      reads?: ReadHistory | null;
    }
  | { file: Exclude<FileJson, Concept>; head: number };

/**
 * Everything a file's page shows, in one request (TEMPRA-191): the file and, for a concept, its
 * sources, links and history, read by the server at one seq (and by the concept's own path,
 * however it was asked for).
 */
export async function loadFile(urls: Urls, path: string): Promise<FileData> {
  const page = await api<PageJson>(urls.api(`page/${enc(path)}`, { at: urls.at }));
  if (!("sources" in page)) return { file: page.file, head: page.head, extra: null };
  const { file, head, sources, links, history } = page;
  return {
    file,
    head,
    extra: { concept: file, sources, links, history: history.events, reads: page.reads ?? null },
  };
}

// What a file's page loads: loaded ahead from links and the switcher, awaited by a navigation.
registerPage("file", (route, urls) => ({
  key: fileKey(urls, route.path),
  load: () => loadFile(urls, route.path),
}));

/** A concept's title: its frontmatter's, else its file name. */
export function titleOf(c: Concept): string {
  const t = c.frontmatter.title;
  return typeof t === "string" && t ? t : baseName(c.path);
}

/** A version of the concept: a content event in its history, numbered from the first. */
export interface Version {
  n: number;
  event: HistoryEvent;
}

/**
 * The concept's versions and where it stands with people (tempra-dev: app/reader, The byline):
 * every content event numbered in order, the latest human verification, and how many versions
 * came after it.
 */
export interface Standing {
  versions: Version[];
  /** The version on screen (the latest, or the pinned one). */
  current: Version | null;
  /** The latest verification by a person, and the version it verified. */
  verified: { event: HistoryEvent; version: Version | null } | null;
  /** Versions written since that verification (0 when the verified version is current). */
  since: number;
}

export function standing(events: HistoryEvent[], seq: number): Standing {
  const versions: Version[] = [];
  for (const e of events) {
    if (CONTENT_OPS.has(e.op) && e.op !== "delete")
      versions.push({ n: versions.length + 1, event: e });
  }
  const current = [...versions].reverse().find((v) => v.event.seq <= seq) ?? null;
  const human = [...events]
    .reverse()
    .find((e) => e.op === "verify" && e.actor.startsWith("human:") && e.seq <= seq);
  if (!human) return { versions, current, verified: null, since: 0 };
  const version = [...versions].reverse().find((v) => v.event.seq <= human.seq) ?? null;
  const since = versions.filter((v) => v.event.seq > human.seq && v.event.seq <= seq).length;
  return { versions, current, verified: { event: human, version }, since };
}
