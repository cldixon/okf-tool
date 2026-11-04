/**
 * A `vega-lite` fence drawn in the reader (TEMPRA-207; tempra-dev: app/diagrams): its data made
 * inline from the library (@tempra/editor `inlineChartData`, the same rule as the server: inline
 * or a file in this library, nothing else fetched), compiled by Vega-Lite and drawn by Vega as an
 * SVG string at the figure's width, themed for the page's scheme (greys for axes and text, the
 * chart series for its categories, TEMPRA-217). Vega's expressions run in its interpreter, never
 * `new Function` (the shell's CSP has no 'unsafe-eval'), and its loader loads nothing. The SVG is sanitized as an SVG fence is (links
 * and images an encoding might add go, ids are prefixed per figure) and brought in through the
 * CSSOM (./svgdom.ts). Loaded on demand: Vega is a chunk of its own.
 */
import { chartSeries, peleThemes } from "@tempra/design/pele";
import {
  chartConfig,
  inlineChartData,
  parseChart,
  sanitizeSvg,
  sizedChart,
} from "@tempra/editor/doc";
import { loader, parse, Error as VegaError, View } from "vega";
import { expressionInterpreter } from "vega-interpreter";
import { compile } from "vega-lite";
import { svgNode } from "./svgdom";

/** The largest drawing of a chart that is shown, in characters of SVG. */
const CHART_SVG_MAX = 4_000_000;

/** What a chart needs beyond its source: where it is, and how to read a library file's text. */
export interface ChartContext {
  width: number;
  idPrefix: string;
  /** The page's library path, for relative data paths. */
  path: string;
  read(path: string): Promise<string | null>;
}

/** The page's scheme, as the shell sets it (`data-theme`) or the system says. */
function scheme(doc: Document): "light" | "dark" {
  const set = doc.documentElement.dataset.theme;
  if (set === "light" || set === "dark") return set;
  return doc.defaultView?.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function noNetwork() {
  const l = loader();
  const refuse = async (uri: string) => {
    throw new Error(`data from ${uri} is not loaded`);
  };
  l.load = refuse;
  // A link or an image's address is asked for here too: none is given (and links are sanitized
  // out of the drawing besides).
  l.sanitize = (async () => ({ href: "" })) as unknown as typeof l.sanitize;
  return l;
}

/** `source` drawn as an SVG element of `doc`; throws what is wrong when it cannot be. */
export async function chartFigure(
  doc: Document,
  source: string,
  ctx: ChartContext,
): Promise<SVGSVGElement> {
  const parsed = parseChart(source);
  if (!parsed.ok) {
    throw new Error(
      `the chart ${parsed.message}${parsed.line > 0 ? ` (line ${parsed.line}, column ${parsed.column})` : ""}`,
    );
  }
  const spec = await inlineChartData(parsed.spec, ctx.path, ctx.read);
  const { spec: vega } = compile(sizedChart(spec, ctx.width) as never, {
    config: chartConfig(peleThemes[scheme(doc)], chartSeries[scheme(doc)]) as never,
  });
  const view = new View(parse(vega, undefined, { ast: true }), {
    renderer: "none",
    expr: expressionInterpreter,
    loader: noNetwork(),
  });
  view.logLevel(VegaError);
  let svg: string;
  try {
    svg = await view.toSVG();
  } finally {
    view.finalize();
  }
  const clean = sanitizeSvg(svg, { idPrefix: ctx.idPrefix, maxLength: CHART_SVG_MAX });
  if (!clean.ok) throw new Error(`the chart's drawing did not parse: ${clean.message}`);
  return svgNode(clean.svg, doc);
}
