/**
 * Comment threads (tempra-dev: app/comments): the shapes the store takes and returns, and the
 * checks that need no database. The store records each action as a `comment` event and keeps
 * the `threads` and `comments` tables in step with it.
 */
import { MAX_QUOTE, type QuoteSelector } from "@tempra/editor/doc";
import { StoreError } from "./errors";

/** Longest comment body, in characters. */
export const MAX_COMMENT = 10_000;

/** The anchor as stored: a quote selector and the sequence it was made at. */
export interface StoredAnchor extends QuoteSelector {
  seq: number;
}

/**
 * Who a comment names (TEMPRA-73), resolved by the Worker before the write against the people
 * who can reach the library, and kept in the action's meta as they were then: a person by users
 * id and the handle used, or a library's managed agent (none yet: TEMPRA-69 will add them).
 */
export type Mention = { user: string; handle: string } | { agent: string; name: string };

/**
 * What a thread is (TEMPRA-222): a comment, or a request, a bigger ask the library's managed agent
 * (or anyone) left open for people's own agents to do, listed in `work` as a `request` item.
 */
export type ThreadKind = "comment" | "request";

/** A thread kind as sent, checked; undefined when none was sent. */
export function threadKind(raw: unknown): ThreadKind | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined;
  if (raw === "comment" || raw === "request") return raw;
  throw new StoreError(400, "bad_kind", "A thread's kind is comment or request.");
}

export type CommentAction = (
  | {
      kind: "open";
      /**
       * The page to comment on; empty (or absent) for a library thread, on the library itself
       * rather than a page (TEMPRA-222), which takes no anchor.
       */
      path?: string | null;
      body: string;
      /**
       * What is quoted. With `from` (the app), the document's text and where in it the quote
       * starts, which picks among repeats; without it (agents), markdown as `read` shows it,
       * matched by the text it reads as.
       */
      anchor?: { quote: string; from?: number } | null;
      /** The thread's kind; a comment unless said. */
      thread_kind?: ThreadKind;
    }
  | {
      kind: "reply";
      thread: string;
      body: string;
      /** Marks the thread a request (or a comment again) with the reply. */
      thread_kind?: ThreadKind;
    }
  | { kind: "resolve"; thread: string; body?: string | null }
  | { kind: "reopen"; thread: string; body?: string | null }
) & {
  /** Resolved by the Worker (notify.ts); never taken from a client as sent. */
  mentions?: Mention[];
};

export type ThreadStatus = "open" | "resolved";

/** The person and agent behind an actor (TEMPRA-75), by id, from the event's meta. */
export interface ActionBy {
  person: string;
  agent?: string;
}

export interface CommentView {
  id: string;
  actor: string;
  /** Who wrote it, by id; absent for comments recorded before `by` was kept. */
  by?: ActionBy;
  body: string;
  ts: string;
  seq: number;
  /** The handles (or agent names) the comment mentioned, as they were when it was written. */
  mentions?: string[];
}

export interface ThreadView {
  id: string;
  /** The page's path; "" for a library thread (TEMPRA-222). */
  path: string;
  /** A comment, or a request left for people's agents (TEMPRA-222). */
  kind: ThreadKind;
  status: ThreadStatus;
  /** Who opened it. */
  actor: string;
  created_seq: number;
  /** The last action on it (a reply, resolve or reopen). */
  last_seq: number;
  last_actor: string;
  resolved_by: string | null;
  resolved_seq: number | null;
  replies: number;
  anchor: StoredAnchor | null;
  /** Where the quote is in the current document's text; null when outdated or unanchored. */
  located: { from: number; to: number } | null;
  /** Anchored, but the quoted text is gone from the current body. */
  outdated: boolean;
  /** The opening comment, then the replies, oldest first. */
  comments: CommentView[];
  /**
   * Every action on the thread in order (open, reply, resolve, reopen), so a transcript shows
   * when it was resolved and reopened; `comment` names the comment an action added, if any.
   */
  actions: ThreadAction[];
}

export interface ThreadAction {
  kind: "open" | "reply" | "resolve" | "reopen";
  actor: string;
  by?: ActionBy;
  ts: string;
  seq: number;
  comment: string | null;
}

export interface CommentResult {
  request_id: string;
  seq: number;
  thread: ThreadView;
  /**
   * Who the action may concern, as users ids from the ledger's `by` (notify.ts decides who is
   * told): the people who opened or wrote in the thread, and who wrote or verified the page.
   */
  people: { participants: string[]; writers: string[] };
}

/** A comment body, trimmed; refused when empty or too long. */
export function commentBody(raw: unknown, required: boolean): string | null {
  const body = typeof raw === "string" ? raw.trim() : "";
  if (!body) {
    if (required) throw new StoreError(400, "empty_comment", "A comment needs a body.");
    return null;
  }
  if (body.length > MAX_COMMENT) {
    throw new StoreError(
      400,
      "comment_too_long",
      `A comment is at most ${MAX_COMMENT} characters; this one is ${body.length}.`,
    );
  }
  return body;
}

/** A quote to anchor on: not empty, not too long. */
export function checkQuote(quote: unknown): string {
  if (typeof quote !== "string" || quote.length === 0) {
    throw new StoreError(400, "bad_anchor", "An anchor needs the quoted text.");
  }
  if (quote.length > MAX_QUOTE) {
    throw new StoreError(
      400,
      "bad_anchor",
      `Quote at most ${MAX_QUOTE} characters; comment on the page instead.`,
    );
  }
  return quote;
}
