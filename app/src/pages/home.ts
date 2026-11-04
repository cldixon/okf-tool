import { byPerson, type LedgerRequest } from "../activity";
import type { ActedBy } from "../agents";
import { api } from "../api";
import { registerPage } from "../prefetch";
import { fileLabel, type OutlineFile } from "../tree";
import type { Urls } from "../urls";

/** The requests read for Recently changed and the empty library's line. */
export const READ = 20;

/** The cache key of a library's home (see useLoad). */
export const homeKey = (urls: Urls) => `home ${urls.base}`;

/** What the home loads first: the head and page count, and the newest requests. */
export async function loadHome(urls: Urls) {
  const [summary, page] = await Promise.all([
    api<{ seq: number; pages: number }>(urls.api("summary")),
    api<{ requests: LedgerRequest[] }>(urls.api("requests", { limit: READ })),
  ]);
  return {
    head: summary.seq,
    pages: summary.pages,
    requests: page.requests,
    latest: page.requests.find((r) => !byPerson(r)) ?? null,
    // No agent among the newest requests, and no older ones: no agent has written here yet.
    noAgentYet: page.requests.length < READ && !page.requests.some((r) => !byPerson(r)),
  };
}

// The home is the library's root; any other folder's address redirects to it.
registerPage("directory", (route, urls) =>
  route.dir === "" ? { key: homeKey(urls), load: () => loadHome(urls) } : null,
);

/** How many pages Recently changed lists. */
const RECENT = 5;

/** A page an agent or a person changed lately, as Recently changed lists it. */
export interface Changed {
  path: string;
  title: string;
  ts: string;
  actor: string;
  by: ActedBy | null;
}

/** Events that make a new version of a page (not a comment, a verification or a delete). */
const CHANGES = new Set(["put", "import", "move", "revert"]);

/**
 * The pages changed most recently, newest first, each once, from the newest requests: only
 * pages still in the library (by the path they have now), each with who changed it and when.
 */
export function recentlyChanged(
  requests: LedgerRequest[],
  files: OutlineFile[],
  max = RECENT,
): Changed[] {
  const here = new Map(files.filter((f) => f.kind === "page").map((f) => [f.path, f]));
  const out: Changed[] = [];
  const listed = new Set<string>();
  for (const r of requests) {
    for (const e of [...r.events].reverse()) {
      if (!CHANGES.has(e.op) || listed.has(e.path)) continue;
      const f = here.get(e.path);
      if (!f) continue;
      listed.add(e.path);
      out.push({ path: e.path, title: fileLabel(f), ts: e.ts, actor: r.actor, by: r.by ?? null });
      if (out.length === max) return out;
    }
  }
  return out;
}
