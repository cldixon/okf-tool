import type { Doc } from "@tempra/editor/doc";
import { lintFields } from "./lint";
import { scanDoc } from "./markdown";
import type { Json, JsonObject, LintWarning } from "./types";

/**
 * The link-health process's checks (TEMPRA-65; tempra-dev: v2/maintainers), free of the store:
 * what a page's stored tree says about its footnotes, worked out the way a write works it out,
 * so the daily pass and the write path can never disagree on what is dangling.
 */

/**
 * The footnote lint the pass owns: a marker with no `sources[].id` (`footnote_unmatched`) or with
 * no definition line (`footnote_undefined`). Both are checked on writes and imports alike.
 */
export const FOOTNOTE_CODES: ReadonlySet<string> = new Set([
  "footnote_unmatched",
  "footnote_undefined",
]);

/** A page's dangling footnotes from its stored frontmatter and tree, as lint. */
export function danglingFootnotes(
  fm: [string, Json][],
  generated: JsonObject | null,
  doc: Doc,
  path: string,
): LintWarning[] {
  return lintFields(fm, generated, [], scanDoc(doc, path)).filter((l) =>
    FOOTNOTE_CODES.has(l.code),
  );
}

/** Whether two lists of lint name the same problems, in any order. */
export function sameLint(a: LintWarning[], b: LintWarning[]): boolean {
  const key = (l: LintWarning[]) =>
    l
      .map((x) => `${x.code}\u0000${x.message}`)
      .sort()
      .join("\u0001");
  return key(a) === key(b);
}

/** Whether two lists of link targets name the same paths, duplicates aside. */
export function sameTargets(a: Iterable<string>, b: Iterable<string>): boolean {
  const x = new Set(a);
  const y = new Set(b);
  return x.size === y.size && [...x].every((t) => y.has(t));
}
