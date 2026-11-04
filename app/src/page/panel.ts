/**
 * The concept's panels (take 4, TEMPRA-114; tempra-dev: app/reader, The panels;
 * decisions/one-panel-from-the-top-bar): one at a time in the contents' column, opened from the
 * top bar's tools (or a quote, or `?panel=`), never by itself, and never remembered.
 */
export type PanelName = "comments" | "history" | "properties";

export const PANEL_TITLES: Record<PanelName, string> = {
  comments: "Comments",
  history: "History",
  properties: "Properties",
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
  if (p === "comments" || p === "history" || p === "properties") return p;
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
