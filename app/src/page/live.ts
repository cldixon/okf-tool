import type { FeedEvent } from "../live";

/*
 * Live (tempra-dev: app/live): someone else's change to the open file shows as a pulsing glyph
 * beside the page's controls, and the new version swaps in by itself only while the reader is
 * idle and not writing a comment. A move or a delete is a notice on the page instead. Pinned
 * versions stay put.
 */

/** Someone else's change to the open file, as the page shows it. */
export interface Live {
  change: FeedEvent;
  /** The sequence of the version on screen, for the diff. */
  shownSeq: number;
  onSwap(): void;
}

/** "Claude for @ann changed this 4 min ago: the note." */
export function changeLine(e: FeedEvent, by: string, since: string): string {
  const what =
    e.op === "delete"
      ? "deleted this"
      : e.op === "move"
        ? "moved this"
        : e.op === "verify"
          ? "verified this"
          : "changed this";
  return `${by} ${what} ${since}${e.note ? `: ${e.note}` : ""}.`;
}
