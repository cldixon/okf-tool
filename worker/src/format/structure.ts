import { dirname } from "./paths";

/**
 * Directory and index health (TEMPRA-64). A directory's index.md is synthesized on read from its
 * pages' titles and descriptions, so what makes an index poor is the pages behind it. These
 * checks find that, deterministically and without a model; the structure process stores what they
 * find as `structure` flags, one per page and one per directory, and never rewrites anything.
 * Free of Worker APIs and of the store, so the thresholds can be tuned on the sample bundles.
 */

/** A description longer than this does not fit an index line. */
export const DESCRIPTION_MAX = 200;
/** A directory holding more pages than this (directly) may be worth splitting. */
export const LARGE_DIRECTORY = 50;

export type StructureCode =
  | "long_description"
  | "description_repeats_title"
  | "missing_descriptions"
  | "duplicate_titles"
  | "large_directory";

export interface StructureIssue {
  code: StructureCode;
  message: string;
  /** The pages it names, for a directory's issues. */
  paths?: string[];
}

/** What the checks read about one file: its place, and for a page its index line. */
export interface StructureEntry {
  path: string;
  kind: string;
  page_id: string;
  title: string | null;
  description: string | null;
}

/** The key a directory's flag is stored under: flags are keyed by page ID, so `dir:<path>`. */
export const dirKey = (dir: string) => `dir:${dir}`;
export const isDirKey = (key: string) => key.startsWith("dir:");
/** The index.md a directory's issues are reported on ("index.md" at the root). */
export const dirIndex = (dir: string) => (dir === "" ? "index.md" : `${dir}/index.md`);

const ACTIONS: Record<StructureCode, string> = {
  long_description:
    "Shorten the description to one line the index can show (under 200 characters); move detail into the body.",
  description_repeats_title:
    "Rewrite the description to say what the page is or covers, not its title again.",
  missing_descriptions:
    "Give each page listed a one-line description; the index shows it beside the title.",
  duplicate_titles:
    "Make the titles say how the pages differ, or merge them into one if they describe the same thing.",
  large_directory:
    "Consider splitting the directory into subdirectories by topic, if readers would find their way better.",
};

/** What to do about a set of issues, one sentence per kind, in a stable order. */
export function structureAction(issues: StructureIssue[]): string {
  const codes = new Set(issues.map((i) => i.code));
  return (Object.keys(ACTIONS) as StructureCode[])
    .filter((c) => codes.has(c))
    .map((c) => ACTIONS[c])
    .join(" ");
}

/** Words for comparing titles: case, accents, punctuation and a plural `s` do not count. */
function words(s: string): string[] {
  return s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w !== "" && !STOP.has(w))
    .map((w) => (w.length > 3 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w));
}
const STOP = new Set(["a", "an", "the", "of"]);

/** Two titles that read the same once case, punctuation, plurals and articles are set aside. */
export const titleKey = (title: string) => words(title).join(" ");

/** The checks on one page's own index line. */
export function descriptionIssues(
  title: string | null,
  description: string | null,
): StructureIssue[] {
  const d = description?.trim() ?? "";
  if (d === "") return []; // missing_description lint says so, and its directory rolls it up
  const out: StructureIssue[] = [];
  if (d.length > DESCRIPTION_MAX) {
    out.push({
      code: "long_description",
      message: `The description is ${d.length} characters; an index line fits ${DESCRIPTION_MAX}.`,
    });
  }
  if (title) {
    const t = new Set(words(title));
    const w = words(d);
    if (t.size > 0 && w.length > 0 && w.every((x) => t.has(x))) {
      out.push({
        code: "description_repeats_title",
        message: "The description only repeats the title.",
      });
    }
  }
  return out;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
/** Paths for a message: the first few, and how many more. */
const LISTED = 5;
const list = (paths: string[]) =>
  paths
    .slice(0, LISTED)
    .map((p) => `/${p}`)
    .join(", ") + (paths.length > LISTED ? ` and ${paths.length - LISTED} more` : "");

/**
 * Runs the checks. `entries` must hold every file under each directory checked; `dirs` limits
 * which directories (and which directories' pages) are checked, or null for all of them.
 * Returns the issues by flag key: a page's ID, or `dirKey(dir)`. Keys with no issues are absent.
 * Only what makes an index read poorly is checked: how a library is laid out, how many pages a
 * folder holds and what links where are the library's own choice (tempra-dev:
 * decisions/pages-not-okf).
 */
export function checkStructure(
  entries: StructureEntry[],
  dirs: Set<string> | null,
): Map<string, StructureIssue[]> {
  const out = new Map<string, StructureIssue[]>();
  const add = (key: string, issue: StructureIssue) => {
    const list = out.get(key);
    if (list) list.push(issue);
    else out.set(key, [issue]);
  };
  const inScope = (dir: string) => dirs === null || dirs.has(dir);

  // Each directory's own pages.
  const tree = new Map<string, StructureEntry[]>();
  for (const e of entries) {
    if (e.kind !== "page") continue;
    const dir = dirname(e.path);
    const pages = tree.get(dir);
    if (pages) pages.push(e);
    else tree.set(dir, [e]);
  }

  for (const [dir, pages] of tree) {
    if (!inScope(dir)) continue;
    const key = dirKey(dir);
    const n = pages.length;

    // Pages: their own index line.
    for (const c of pages) {
      for (const issue of descriptionIssues(c.title, c.description)) add(c.page_id, issue);
    }

    const missing = pages.filter((c) => !c.description?.trim()).map((c) => c.path);
    if (missing.length > 0) {
      add(key, {
        code: "missing_descriptions",
        message: `${plural(missing.length, "page")} of ${n} ${missing.length === 1 ? "has" : "have"} no description, so the index shows a bare title: ${list(missing)}.`,
        paths: missing,
      });
    }

    const byTitle = new Map<string, string[]>();
    for (const c of pages) {
      const k = c.title ? titleKey(c.title) : "";
      if (k === "") continue;
      byTitle.set(k, [...(byTitle.get(k) ?? []), c.path]);
    }
    const dupes = [...byTitle.values()].filter((p) => p.length > 1);
    if (dupes.length > 0) {
      add(key, {
        code: "duplicate_titles",
        message: `Titles that read the same: ${dupes.map((p) => p.map((x) => `/${x}`).join(" and ")).join("; ")}.`,
        paths: dupes.flat(),
      });
    }

    if (n > LARGE_DIRECTORY) {
      add(key, {
        code: "large_directory",
        message: `${n} pages directly here; an index reads well up to about ${LARGE_DIRECTORY}.`,
      });
    }
  }
  return out;
}
