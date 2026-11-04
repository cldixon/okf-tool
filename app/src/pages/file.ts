import { actedBy, type FileJson, type HistoryEvent } from "../page/data";
import { sizeText } from "./attachment";

/*
 * A file's page (File.svelte): a page in its own layout, an attachment (board 28), a
 * synthesized file, or Not found. Its pure parts.
 */

export type AttachmentFile = Extract<FileJson, { kind: "attachment" }>;

/** The attachment page's image: the screen on a phone, else most of the window (views.css). */
export const ATTACHMENT_SIZES = "(max-width: 900px) 100vw, 70vw";

/** How many using pages the page reads for their figures and sources. */
export const USES_READ = 12;

/** What the last server action did, said once on the page it returns to (`?done=`). */
export const DONE: Record<string, (actor: string) => string> = {
  restore: () => "Restored, as a new change by you.",
  verify: () => "Checked. It stays checked until the next edit.",
};

/** "PNG image", "PDF document", "SVG image", else the media type, else "File". */
export function typeName(media: string | null, path: string): string {
  const ext = /\.([a-z0-9]+)$/i.exec(path)?.[1]?.toUpperCase();
  if (!media) return ext ? `${ext} file` : "File";
  const [kind, sub = ""] = media.split("/");
  const name = (sub.split("+")[0] ?? sub).toUpperCase();
  if (kind === "image") return `${name === "SVG" ? "SVG" : name === "JPEG" ? "JPEG" : name} image`;
  if (media === "application/pdf") return "PDF document";
  if (kind === "text") return `${name === "PLAIN" ? "Text" : name} file`;
  if (kind === "video") return `${name} video`;
  if (kind === "audio") return `${name} audio`;
  return media;
}

/**
 * Size: its bytes, and its pixels from the image's header (TEMPRA-152), known before the image
 * loads; else what the browser found once it did.
 */
export function sizeFact(
  file: Pick<AttachmentFile, "size" | "width" | "height">,
  loaded: { w: number; h: number } | null,
): string {
  const px = file.width && file.height ? { w: file.width, h: file.height } : loaded;
  return sizeText(file.size, px?.w, px?.h);
}

/** What became of a path, from its history: moved elsewhere, deleted, or nothing known. */
type Fate =
  | { kind: "moved"; to: string; actor: string; by: ReturnType<typeof actedBy>; ts: string }
  | { kind: "deleted"; actor: string; by: ReturnType<typeof actedBy>; ts: string }
  | null;

/**
 * Reads a path's history (`GET …/history/{path}`, which finds a file by a path it once had) as
 * what became of it: where it lives now, by the move that took it from this path; or the
 * delete that removed it.
 */
export function fateOf(path: string, history: { path: string; events: HistoryEvent[] }): Fate {
  const events = history.events.filter((e) => e.op !== "comment");
  const last = events.at(-1);
  if (!last) return null;
  if (history.path !== path) {
    const from = (e: HistoryEvent) => e.meta?.from_path;
    const move =
      [...events].reverse().find((e) => e.op === "move" && from(e) === path) ??
      [...events].reverse().find((e) => e.op === "move");
    if (!move) return null;
    return { kind: "moved", to: history.path, actor: move.actor, by: actedBy(move), ts: move.ts };
  }
  if (last.op === "delete") {
    return { kind: "deleted", actor: last.actor, by: actedBy(last), ts: last.ts };
  }
  return null;
}
