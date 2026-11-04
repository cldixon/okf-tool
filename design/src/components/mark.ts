/**
 * The Tempra mark, v1 "Advance" (TEMPRA-279; the Paper file's Brand Logo page): three square
 * plates, each set down and to the left of the one in front, the front plate's top-right corner cut
 * at 45°. The handoff draws it on a 64-unit grid and opens the gaps between plates with masks;
 * here the masks are worked out, so each plate behind is the part of it that shows (an L, the plate
 * in front grown by the gap taken away), and the mark needs no element ids, however many are on a
 * page. The view box is the plates' own box (45 by 50 units of the grid, from x 9.5 and y 7), so
 * the drawn height is the plates' height: placed beside a name, that is 1.2 × its cap height.
 *
 * `small` is for 24px and under: a wider gap (2.6 units against 1.75), so the plates stay apart.
 * Colours are the design CSS's (`.mark-front`, `.mark-mid`, `.mark-back` over the
 * `--tempra-color-mark-*` roles: graphite in light, silver in dark); a favicon, which cannot read a
 * stylesheet, has its own copy (design/favicon.svg).
 */

export const MARK_VIEWBOX = "0 0 45 50";

export type MarkPaths = { back: string; middle: string; front: string };

export const MARK_PATHS: { standard: MarkPaths; small: MarkPaths } = {
  standard: {
    back: "M0 14H2.75V44.75H36V50H0Z",
    middle: "M4.5 7H7.25V37.75H40.5V43H4.5Z",
    front: "M9 0H33L45 12V36H9Z",
  },
  small: {
    back: "M0 14H1.9V45.6H36V50H0Z",
    middle: "M4.5 7H6.4V38.6H40.5V43H4.5Z",
    front: "M9 0H33L45 12V36H9Z",
  },
};

/**
 * The mark as SVG markup, for what renders without Svelte (the Worker's server pages, the landing
 * site, a panel built from the DOM). Decorative unless `label` names it.
 */
export function markSvg(
  opts: { small?: boolean; className?: string; label?: string } = {},
): string {
  const p = MARK_PATHS[opts.small ? "small" : "standard"];
  const cls = ["mark", opts.className].filter(Boolean).join(" ");
  const named = opts.label
    ? ` role="img" aria-label="${opts.label.replace(/[&"<>]/g, (c) => `&#${c.charCodeAt(0)};`)}"`
    : ' aria-hidden="true"';
  return (
    `<svg class="${cls}" viewBox="${MARK_VIEWBOX}" xmlns="http://www.w3.org/2000/svg"${named}>` +
    `<path class="mark-back" d="${p.back}"/>` +
    `<path class="mark-mid" d="${p.middle}"/>` +
    `<path class="mark-front" d="${p.front}"/></svg>`
  );
}
