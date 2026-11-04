import type { Heading, Prepared } from "../reader/prepare";

/**
 * The concept's contents (take 4; tempra-dev: app/reader, Contents): its top two heading levels,
 * nested, on the right of the page while no panel is open and there is room, otherwise under the
 * byline ("On this page"). The section in view is marked with a rule.
 */

/** A heading in the contents: a section, or one level under it. */
export interface Entry extends Heading {
  sub: boolean;
}

/**
 * The headings the contents list: the body's top two levels (h2 and h3 in most concepts; a
 * leading heading repeating the title aside).
 */
export function contentsOf(prepared: Prepared, skipFirst: boolean): Entry[] {
  const headings = skipFirst ? prepared.headings.slice(1) : prepared.headings;
  const top = Math.min(...headings.map((h) => h.depth));
  return headings.filter((h) => h.depth <= top + 1).map((h) => ({ ...h, sub: h.depth > top }));
}
