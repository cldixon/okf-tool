/**
 * Comments on a page (tempra-dev: app/comments, TEMPRA-13): threads live in the ledger; the
 * page loads a page's with `GET …/comments?path=` (reloaded when the feed says one changed,
 * `data.svelte.ts`), finds each quote in the body on screen, and keeps the draft started from the
 * selection toolbar.
 */
import { type DocText, locate, type QuoteSelector } from "@tempra/editor";
import type { ActedBy } from "../agents";
import type { Highlight } from "../reader/reading";

export interface CommentT {
  id: string;
  actor: string;
  /** Who wrote it, by id (TEMPRA-77); absent on comments from before it was kept. */
  by?: ActedBy;
  body: string;
  ts: string;
  seq: number;
}

export interface Thread {
  id: string;
  /** The page's path; "" for a thread on the library itself (TEMPRA-222). */
  path: string;
  /** A request is a bigger ask left for people's agents (TEMPRA-222); a comment otherwise. */
  kind?: "comment" | "request";
  status: "open" | "resolved";
  actor: string;
  created_seq: number;
  last_seq: number;
  resolved_by: string | null;
  replies: number;
  anchor: (QuoteSelector & { seq: number }) | null;
  comments: CommentT[];
  /** Every action in order: open, reply, resolve and reopen, with the comment each added. */
  actions?: {
    kind: "open" | "reply" | "resolve" | "reopen";
    actor: string;
    by?: ActedBy;
    ts: string;
    seq: number;
    comment: string | null;
  }[];
}

/** Where a thread's quote is in the body on screen, as text offsets. */
export interface Placed extends Thread {
  at: { from: number; to: number } | null;
}

/** Each thread's quote found in the version on screen, as the server would find it. */
export function placeThreads(threads: Thread[], text: DocText): Placed[] {
  return threads.map((t) => ({ ...t, at: t.anchor ? locate(text, t.anchor) : null }));
}

/** The highlights for the reader: open threads whose quote is on screen, and the draft. */
export function highlightsOf(
  placed: Placed[],
  active: string | null,
  draft: Draft | null,
): Highlight[] {
  const marks: Highlight[] = placed
    .filter((t) => t.status === "open" && t.at && t.at.to > t.at.from)
    .map((t) => ({
      id: t.id,
      from: t.at?.from ?? 0,
      to: t.at?.to ?? 0,
      active: t.id === active,
    }));
  if (draft) marks.push({ id: "draft", from: draft.from, to: draft.to, draft: true });
  return marks;
}

/** A comment being written on a quote: the text quoted, and where it is in the document's text. */
export interface Draft {
  quote: string;
  from: number;
  to: number;
}

/** The path the threads API takes for the library's own threads (TEMPRA-222). */
export const LIBRARY_THREADS = "/";

/** A piece of a comment's text: words, or a link it names (a URL, or a page by its path). */
export type CommentPart = { text: string } | { text: string; href: string };

const LINKS = /(https?:\/\/[^\s<>"')\]]+[^\s<>"')\].,;:!?])|(?<![\w/.])(\/[\w./-]*[\w-]\.md)\b/g;

/** A page's path as a comment shows it: no leading slash, no `.md` (TEMPRA-225). */
const shown = (path: string) => path.replace(/^\//, "").replace(/\.md$/, "");

/**
 * A comment's text with its links (TEMPRA-222: the library's agent cites pages by path, people
 * and older replies by URL): http(s) URLs as they are, except a page of this library (`library`,
 * the library's own URL with its trailing slash), which, like `/dir/page.md`, links to the page
 * in this app (`file`) and reads as its path without `.md` (`dir/page`; TEMPRA-225). Nothing
 * else is markup: the text stays text.
 */
export function commentParts(
  body: string,
  file: (path: string) => string,
  library?: string,
): CommentPart[] {
  const out: CommentPart[] = [];
  let at = 0;
  for (const m of body.matchAll(LINKS)) {
    const i = m.index ?? 0;
    if (i > at) out.push({ text: body.slice(at, i) });
    const [whole, url, path] = m;
    if (url) {
      const page =
        library && url.startsWith(library) ? libraryPage(url.slice(library.length)) : null;
      out.push(
        page
          ? { text: shown(page.path), href: file(page.path) + page.rest }
          : { text: url, href: url },
      );
    } else {
      out.push({ text: shown(path ?? ""), href: file((path ?? "").slice(1)) });
    }
    at = i + whole.length;
  }
  if (at < body.length) out.push({ text: body.slice(at) });
  return out;
}

/** A URL's rest after the library's own URL, when it is a page there: its path and its query. */
function libraryPage(rest: string): { path: string; rest: string } | null {
  const cut = rest.search(/[?#]/);
  const raw = cut === -1 ? rest : rest.slice(0, cut);
  if (!raw.endsWith(".md") || raw.startsWith("-/")) return null;
  try {
    return { path: decodeURIComponent(raw), rest: cut === -1 ? "" : rest.slice(cut) };
  } catch {
    return null;
  }
}

/**
 * Threads of one status in the order the Comments panel lists them: those on the whole page
 * (and those whose quote is gone) first, then the rest in document order.
 */
export function panelOrder(placed: Placed[], status: Thread["status"]): Placed[] {
  return placed
    .filter((t) => t.status === status)
    .sort((a, b) => (a.at?.from ?? -1) - (b.at?.from ?? -1) || a.created_seq - b.created_seq);
}
