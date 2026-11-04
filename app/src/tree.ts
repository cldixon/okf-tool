/* The tree's data (Tree.svelte): the library's index as `GET …/outline` lists it. */

import { baseName, dirOf, folderName, type Urls } from "./urls";

/** One file of `GET …/outline`: the library's index, without bodies. */
export interface OutlineFile {
  path: string;
  kind: "dir" | "page" | "attachment";
  title?: string | null;
  seq?: number | null;
  /** Open comment threads on it. */
  comments?: number;
  /** Past its stale_after, or within 14 days of it (the staleness process's flags). */
  stale?: "stale" | "stale_soon";
}

/** Names in the order people read them ("Part 2" before "Part 10"); one collator for every sort. */
const BY_NAME = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/** A file as the tree names it: a page by its title, anything else by its file name. */
export function fileLabel(e: OutlineFile): string {
  return e.kind === "page" && e.title ? e.title : baseName(e.path);
}

/** The least time between two refreshes of the index while writes keep coming. */
export const REFRESH_MS = 3000;

/** A path's folders, outermost first (not the root). */
export const ancestors = (path: string) => {
  const out: string[] = [];
  for (let d = dirOf(path); d !== ""; d = dirOf(d)) out.unshift(d);
  return out;
};

/*
 * Every folder starts open, the library laid out as a docs site's sidebar is (TEMPRA-146); what
 * is remembered is the folders the person closed. (The key changed with it: the old one listed
 * the open folders.)
 */
const closedKey = (urls: Urls) => `tempra:tree-closed:${urls.owner}/${urls.slug}`;

export function loadClosed(urls: Urls): Set<string> {
  try {
    const v = JSON.parse(localStorage.getItem(closedKey(urls)) ?? "[]") as unknown;
    return new Set(Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  } catch {
    return new Set();
  }
}

export function saveClosed(urls: Urls, dirs: Set<string>) {
  try {
    localStorage.setItem(closedKey(urls), JSON.stringify([...dirs]));
  } catch {
    // Storage off: every folder opens again next time.
  }
}

/** Where a row sorts within its folder: folders, then pages, then files (TEMPRA-123). */
const RANK: Record<OutlineFile["kind"], number> = { dir: 0, page: 1, attachment: 2 };

/** A row as the tree names it, for sorting by what the person sees. */
const shown = (e: OutlineFile) => (e.kind === "dir" ? folderName(e.path) : fileLabel(e));

/**
 * Every folder's children from the flat list of files: folders first, then pages, then files,
 * each by the name the tree shows.
 */
export function buildDirs(files: OutlineFile[]): Record<string, OutlineFile[]> {
  const dirs = new Map<string, Map<string, OutlineFile>>([["", new Map()]]);
  const at = (d: string) => {
    let m = dirs.get(d);
    if (!m) {
      m = new Map();
      dirs.set(d, m);
    }
    return m;
  };
  for (const f of files) {
    at(dirOf(f.path)).set(f.path, f);
    for (const d of ancestors(f.path)) at(dirOf(d)).set(d, { path: d, kind: "dir" });
  }
  const out: Record<string, OutlineFile[]> = {};
  for (const [d, m] of dirs) {
    out[d] = [...m.values()].sort(
      (a, b) =>
        RANK[a.kind] - RANK[b.kind] ||
        BY_NAME.compare(shown(a), shown(b)) ||
        a.path.localeCompare(b.path),
    );
  }
  return out;
}

/** Every file under each folder, at any depth: what a closed folder rolls up. */
export function insideDirs(files: OutlineFile[]): Map<string, OutlineFile[]> {
  const inside = new Map<string, OutlineFile[]>();
  for (const f of files) {
    for (const d of ancestors(f.path)) {
      const list = inside.get(d);
      if (list) list.push(f);
      else inside.set(d, [f]);
    }
  }
  return inside;
}

/**
 * A closed folder's marks: the open comments added up, and stale if anything inside is (else
 * stale soon).
 */
export function rollUp(all: OutlineFile[]): { comments: number; stale: OutlineFile["stale"] } {
  let comments = 0;
  let stale: OutlineFile["stale"];
  for (const f of all) {
    comments += f.comments ?? 0;
    if (f.stale === "stale" || (f.stale && !stale)) stale = f.stale;
  }
  return { comments, stale };
}
