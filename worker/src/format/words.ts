import { ATOM } from "@tempra/editor/doc";

/** Words a text holds, split on whitespace; an atom (an image, a footnote marker) separates. */
const WORD_BREAK = new RegExp(`[\\s${ATOM}]+`, "u");

/**
 * How many words an edit added and removed, for the ledger (Activity's "+38 −12 words"): the
 * difference between the two texts as bags of words, so a word moved is neither, and a word
 * changed is one of each. With the words the text had before, so an edit that removed most of
 * them reads as a rewrite. Not a diff; linear in the texts' length.
 */
export function wordChange(
  before: string,
  after: string,
): { added: number; removed: number; before: number } {
  const counts = new Map<string, number>();
  let had = 0;
  for (const w of before.split(WORD_BREAK)) {
    if (!w) continue;
    counts.set(w, (counts.get(w) ?? 0) + 1);
    had++;
  }
  let added = 0;
  for (const w of after.split(WORD_BREAK)) {
    if (!w) continue;
    const n = counts.get(w) ?? 0;
    if (n > 0) counts.set(w, n - 1);
    else added++;
  }
  let removed = 0;
  for (const n of counts.values()) removed += n;
  return { added, removed, before: had };
}
