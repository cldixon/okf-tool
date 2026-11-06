import { byPerson, type LedgerEvent, type LedgerRequest } from "../activity";
import type { ActedBy } from "../agents";
import { api } from "../api";
import { registerPage } from "../prefetch";
import { fileLabel, type OutlineFile } from "../tree";
import type { Urls } from "../urls";

/** The requests read for the empty library's line. */
export const READ = 20;

/** How many pages Recently changed lists. */
const RECENT = 5;

/**
 * One page as `GET …/changed` lists it (worker/src/store/store.ts `changed`): its last change's
 * event, at the page's path now, with who it was for.
 */
export type ChangedPage = LedgerEvent & { by: ActedBy | null };

/** The cache key of a library's home (see useLoad). */
export const homeKey = (urls: Urls) => `home ${urls.base}`;

/**
 * What the home loads first: the head and page count, the newest requests (for the empty
 * library's line), and the pages changed last. Recently changed reads those from the server,
 * not from the newest requests, where comments and checks would push the edits out (TEMPRA-302).
 */
export async function loadHome(urls: Urls) {
  const [summary, page, changed] = await Promise.all([
    api<{ seq: number; pages: number }>(urls.api("summary")),
    api<{ requests: LedgerRequest[] }>(urls.api("requests", { limit: READ })),
    api<{ pages: ChangedPage[] }>(urls.api("changed", { limit: RECENT })),
  ]);
  return {
    head: summary.seq,
    pages: summary.pages,
    changed: changed.pages,
    latest: page.requests.find((r) => !byPerson(r)) ?? null,
    // No agent among the newest requests, and no older ones: no agent has written here yet.
    noAgentYet: page.requests.length < READ && !page.requests.some((r) => !byPerson(r)),
  };
}

// The home is the library's root; any other folder's address redirects to it.
registerPage("directory", (route, urls) =>
  route.dir === "" ? { key: homeKey(urls), load: () => loadHome(urls) } : null,
);

/** A page an agent or a person changed lately, as Recently changed lists it. */
export interface Changed {
  path: string;
  title: string;
  ts: string;
  actor: string;
  by: ActedBy | null;
}

/**
 * The pages changed most recently, newest first, as the server listed them: only those still
 * in the index (one deleted since stays out until the next load), each titled from it.
 */
export function recentlyChanged(
  changed: ChangedPage[],
  files: OutlineFile[],
  max = RECENT,
): Changed[] {
  const here = new Map(files.filter((f) => f.kind === "page").map((f) => [f.path, f]));
  const out: Changed[] = [];
  for (const e of changed) {
    const f = here.get(e.path);
    if (!f || out.some((c) => c.path === e.path)) continue;
    out.push({ path: e.path, title: fileLabel(f), ts: e.ts, actor: e.actor, by: e.by });
    if (out.length === max) break;
  }
  return out;
}
