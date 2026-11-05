/**
 * The page's panels (take 4, TEMPRA-114; TEMPRA-283; tempra-dev: app/reader, The panels;
 * decisions/page-tools-in-the-corner): one at a time in the contents' column, opened from the
 * page's corner row (or a quote, or `?panel=`), never by itself, and never remembered. Page info
 * holds what History and Properties did.
 */
export type PanelName = "comments" | "info";

export const PANEL_TITLES: Record<PanelName, string> = {
  comments: "Comments",
  info: "Page info",
};

/** How far down (px) a sheet's head is dragged to close it. */
export const DRAG_TO_CLOSE = 60;

/** The id a #fragment names, decoded; null without one. */
function hashId(hash: string): string | null {
  if (hash.length < 2) return null;
  try {
    return decodeURIComponent(hash.slice(1));
  } catch {
    return hash.slice(1);
  }
}

/**
 * The panel a link asks for: `?panel=…`, or a thread or the comments by #fragment. A fragment
 * that names a heading in the body (`bodyIds`; a heading "Comments" is `#comments`) is the
 * heading's, not a panel's: the app's own ids are prefixed (`panel-…`, `doc-sources`) so they
 * never clash with a heading's slug.
 */
export function panelInUrl(
  bodyIds: ReadonlySet<string> = new Set(),
  where: { search: string; hash: string } = location,
): PanelName | null {
  const p = new URLSearchParams(where.search).get("panel");
  if (p === "comments") return p;
  // History and Properties are Page info since TEMPRA-283; their links still open it.
  if (p === "info" || p === "history" || p === "properties") return "info";
  const id = hashId(where.hash);
  if (id === null || bodyIds.has(id)) return null;
  if (id === "comments" || threadInHash(bodyIds, where.hash)) return "comments";
  return null;
}

/** The thread a link names (`#thread-<id>`), unless that is a heading's id in the body. */
export function threadInHash(
  bodyIds: ReadonlySet<string> = new Set(),
  hash: string = location.hash,
): string | null {
  const id = hashId(hash);
  if (id === null || bodyIds.has(id)) return null;
  const m = /^thread-(.+)$/.exec(id);
  return m?.[1] ?? null;
}

/** A thread's element in the Comments panel (prefixed, so a heading's slug never clashes). */
export const threadElementId = (id: string) => `panel-thread-${id}`;
