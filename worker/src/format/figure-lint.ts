/**
 * Figure lint (tempra-dev: app/media, Figure markup and Lint): a `:::figure` whose markup does not
 * parse (a width or layout it cannot read, an attribute it does not take, no images, more than
 * four, or something other than images inside) becomes `figure_invalid` lint naming its block and
 * what is wrong. Lint only, never a refusal: the write lands and the reader draws its images as
 * plain images.
 */
import { checkFigure, type Doc, idOf, isFigure, walk } from "@tempra/editor/doc";
import type { LintWarning } from "./types";

/** Lint for each figure in a body whose markup does not parse. */
export function figureLint(doc: Doc): LintWarning[] {
  const out: LintWarning[] = [];
  let n = 0;
  walk(doc, (node) => {
    if (node.type === "footnoteDefinition") return false;
    if (!isFigure(node)) return undefined;
    n++;
    const check = checkFigure(node);
    if (!check.ok) {
      const block = idOf(node);
      out.push({
        code: "figure_invalid",
        message: `Figure markup ${n} (\`:::figure\`${block ? `, block ${block}` : ""}) does not parse: ${check.problems.join("; ")}. Its images are shown as plain images until it is fixed; a figure is \`:::figure[group caption]{width=480|60% layout=column|wide|full frame}\` around one to four images.`,
        block,
      });
    }
    return false;
  });
  return out;
}
