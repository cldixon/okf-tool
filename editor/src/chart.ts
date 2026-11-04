/**
 * Vega-Lite fences (TEMPRA-207; tempra-dev: app/diagrams, app/media): a chart written as a spec is
 * rendered media, drawn by Vega in the reader and on the render Worker. What both need without
 * Vega or a DOM is here: the spec read as JSON with where it breaks, its data made inline, and the
 * theme from the reader's greys.
 *
 * No network from a spec: data is inline (`values`) or a file in this library (`url`, a path as a
 * link is written); anything else is refused. Delimited text is parsed here, not by Vega's loader,
 * whose CSV reader builds its rows with `new Function`, which the shell's CSP and Workers forbid;
 * columns are typed as Vega's `parse: "auto"` would type them.
 */
import { linkTarget } from "./links";

/** The largest Vega-Lite fence drawn, in characters (as `render`'s limit). */
export const CHART_MAX_SOURCE = 50_000;
/** The largest data file a chart reads from the library, in bytes. */
export const CHART_MAX_DATA = 2 * 1024 * 1024;
/** The most rows a chart's data may have, in all its datasets. */
export const CHART_MAX_ROWS = 50_000;

/** A chart problem, at a 1-based line and column of the fence (0 when it has no place). */
export interface ChartProblem {
  message: string;
  line: number;
  column: number;
}

export type ChartSpec = Record<string, unknown>;

/** 1-based line and column of an offset. */
function place(src: string, at: number): { line: number; column: number } {
  const lines = src.slice(0, Math.max(0, Math.min(at, src.length))).split("\n");
  return { line: lines.length, column: (lines[lines.length - 1] as string).length + 1 };
}

/** The fence as a spec: JSON, an object, small enough; else what is wrong and where. */
export function parseChart(
  source: string,
): { ok: true; spec: ChartSpec } | ({ ok: false } & ChartProblem) {
  if (source.length > CHART_MAX_SOURCE) {
    return {
      ok: false,
      message: `it is longer than the limit of ${CHART_MAX_SOURCE} characters`,
      line: 0,
      column: 0,
    };
  }
  let spec: unknown;
  try {
    spec = JSON.parse(source);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    // V8: "… at position 12 (line 2 column 3)"; JavaScriptCore names no place.
    const pos = /position (\d+)/.exec(message);
    const at = pos ? place(source, Number(pos[1])) : { line: 0, column: 0 };
    return {
      ok: false,
      message: `it is not JSON: ${message.replace(/\s*(?:in JSON )?at position \d+.*$/, "")}`,
      ...at,
    };
  }
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) {
    return { ok: false, message: "a Vega-Lite spec is a JSON object", line: 1, column: 1 };
  }
  return { ok: true, spec: spec as ChartSpec };
}

/** Keys whose value is a view or a list of views (Vega-Lite's compositions). */
const VIEWS = ["layer", "concat", "hconcat", "vconcat", "spec"] as const;

/** Every `data` object in a spec: its own, its views', and lookups' `from.data`. */
export function chartData(spec: ChartSpec): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const isObj = (v: unknown): v is Record<string, unknown> =>
    !!v && typeof v === "object" && !Array.isArray(v);
  const visit = (view: unknown) => {
    if (!isObj(view)) return;
    if (isObj(view.data)) out.push(view.data);
    if (Array.isArray(view.transform)) {
      for (const t of view.transform) {
        if (isObj(t) && isObj(t.from) && isObj(t.from.data)) out.push(t.from.data);
      }
    }
    for (const k of VIEWS) {
      const v = view[k];
      if (Array.isArray(v)) v.forEach(visit);
      else visit(v);
    }
  };
  visit(spec);
  return out;
}

/**
 * Where a chart's data URLs point: the library path of each, or a problem for one that is not a
 * file in this library (`pagePath` resolves a relative one, as links do).
 */
export function chartDataPaths(
  spec: ChartSpec,
  pagePath: string,
): { paths: string[]; problems: string[] } {
  const paths: string[] = [];
  const problems: string[] = [];
  for (const d of chartData(spec)) {
    if (d.url === undefined) continue;
    if (typeof d.url !== "string") {
      problems.push("a data `url` must be a path to a file in this library");
      continue;
    }
    const t = linkTarget(pagePath, d.url);
    if (t?.kind !== "internal" || t.dir || !t.path) {
      problems.push(
        `data from ${d.url} is not read: a chart's data is inline (\`values\`) or a CSV, TSV or JSON file in this library`,
      );
    } else if (!paths.includes(t.path)) paths.push(t.path);
  }
  return { paths, problems };
}

/** Rows of delimited text (RFC 4180 quoting), no header handling. */
export function delimitedRows(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let i = 0;
  let quoted = false;
  const s = text.replace(/^﻿/, "");
  while (i < s.length) {
    const c = s[i] as string;
    if (quoted) {
      if (c === '"') {
        if (s[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
      } else field += c;
      i++;
      continue;
    }
    if (c === '"' && field === "") quoted = true;
    else if (c === delimiter) {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      if (c === "\r" && s[i + 1] === "\n") i++;
    } else field += c;
    i++;
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

type Kind = "boolean" | "integer" | "number" | "date" | "string";

const isBool = (v: string) => /^(true|false)$/i.test(v);
const isInt = (v: string) => /^[-+]?\d+$/.test(v) && Number.isSafeInteger(Number(v));
const isNum = (v: string) => v.trim() !== "" && !Number.isNaN(Number(v));
// Dates as Vega's type inference takes them: anything Date.parse reads that is not a bare number.
const isDate = (v: string) => !isNum(v) && /\d/.test(v) && !Number.isNaN(Date.parse(v));

function kindOf(values: string[]): Kind {
  const present = values.filter((v) => v !== "" && v !== "null" && v !== "NaN");
  if (present.length === 0) return "string";
  for (const [kind, test] of [
    ["boolean", isBool],
    ["integer", isInt],
    ["number", isNum],
    ["date", isDate],
  ] as const) {
    if (present.every(test)) return kind;
  }
  return "string";
}

function typed(v: string, kind: Kind): unknown {
  if (v === "" || v === "null") return kind === "string" ? v : null;
  switch (kind) {
    case "boolean":
      return /^true$/i.test(v);
    case "integer":
    case "number":
      return Number(v);
    case "date":
      return v; // Vega-Lite parses temporal fields itself; the string stays as written.
    default:
      return v;
  }
}

/** Delimited text with a header row as objects, each column typed as `parse: "auto"` does. */
export function delimitedValues(text: string, delimiter: string): Record<string, unknown>[] {
  const [head, ...body] = delimitedRows(text, delimiter).filter(
    (r) => !(r.length === 1 && r[0] === ""),
  );
  if (!head) return [];
  const kinds = head.map((_, i) => kindOf(body.map((r) => r[i] ?? "")));
  return body.map((r) =>
    Object.fromEntries(head.map((h, i) => [h, typed(r[i] ?? "", kinds[i] as Kind)])),
  );
}

export class ChartDataError extends Error {}

/** A dataset's text as values, by its format's type (or the file's extension). */
function valuesOf(text: string, format: Record<string, unknown>, name: string): unknown[] {
  const type = String(
    format.type ?? (/\.tsv$/i.test(name) ? "tsv" : /\.json$/i.test(name) ? "json" : "csv"),
  ).toLowerCase();
  if (type === "csv") return delimitedValues(text, ",");
  if (type === "tsv") return delimitedValues(text, "\t");
  if (type === "dsv") {
    const d =
      typeof format.delimiter === "string" && format.delimiter.length === 1
        ? format.delimiter
        : ",";
    return delimitedValues(text, d);
  }
  if (type === "json") {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new ChartDataError(`${name} is not JSON`);
    }
    if (typeof format.property === "string") {
      for (const k of format.property.split(".")) v = (v as Record<string, unknown> | null)?.[k];
    }
    if (!Array.isArray(v)) throw new ChartDataError(`${name} is not a JSON array of rows`);
    return v;
  }
  throw new ChartDataError(`data of type ${type} is not read; use csv, tsv or json`);
}

/**
 * The spec with every dataset inline as rows: `url` read from the library (`read` gives a file's
 * text, or null when there is none), delimited or JSON text in `values` parsed. A copy; the
 * fence's own spec is untouched. Throws ChartDataError for what cannot be read.
 */
export async function inlineChartData(
  spec: ChartSpec,
  pagePath: string,
  read: (path: string) => Promise<string | null>,
): Promise<ChartSpec> {
  const copy = JSON.parse(JSON.stringify(spec)) as ChartSpec;
  let rows = 0;
  for (const d of chartData(copy)) {
    const format = (d.format && typeof d.format === "object" ? d.format : {}) as Record<
      string,
      unknown
    >;
    let values: unknown[] | undefined;
    if (d.url !== undefined) {
      const t = typeof d.url === "string" ? linkTarget(pagePath, d.url) : null;
      if (t?.kind !== "internal" || t.dir || !t.path) {
        throw new ChartDataError(
          `data from ${String(d.url)} is not read: use a file in this library`,
        );
      }
      const text = await read(t.path);
      if (text === null) throw new ChartDataError(`no file at /${t.path} for the chart's data`);
      if (text.length > CHART_MAX_DATA)
        throw new ChartDataError(`/${t.path} is over ${CHART_MAX_DATA / 1048576} MB`);
      values = valuesOf(text, format, t.path);
      delete d.url;
    } else if (typeof d.values === "string") {
      values = valuesOf(d.values, format, "the inline values");
    } else if (Array.isArray(d.values)) {
      rows += d.values.length;
    }
    if (values) {
      d.values = values;
      // Parsed here; what Vega would do with the format is done.
      const { property: _p, type: _t, delimiter: _d, ...rest } = format;
      if (Object.keys(rest).length > 0) d.format = rest;
      else delete d.format;
      rows += values.length;
    }
  }
  if (rows > CHART_MAX_ROWS)
    throw new ChartDataError(`the chart has ${rows} rows of data, over ${CHART_MAX_ROWS}`);
  return copy;
}

/**
 * The reader's look for a chart, as a Vega-Lite `config`, from the diagram theme's resolved values
 * (`@tempra/design/pele`'s `peleThemes[scheme]`): the page's ground, ink and rules (greys, for
 * axes, grid and text), Inter, and `series` (`chartSeries[scheme]`, the chart colours, TEMPRA-217)
 * as the categories in their fixed order; without them, the diagram theme's series greys. The x
 * axis's labels stay level, thinned rather than drawn over each other when they would collide.
 * An author's own `config` wins.
 */
export function chartConfig(
  theme: Record<string, string>,
  series: readonly string[] = [],
): Record<string, unknown> {
  const v = (k: string, d: string) => theme[`--pele-${k}`] ?? d;
  const fg = v("fg", "#1a1a1b");
  const muted = v("muted", "#616165");
  const border = v("border", "#d2d2ce");
  const font = v("font", "sans-serif");
  const greys = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => v(`series-${n}`, fg));
  const category = series.length > 0 ? [...series] : greys;
  const axis = {
    domainColor: muted,
    gridColor: border,
    tickColor: muted,
    labelColor: muted,
    titleColor: fg,
    labelFont: font,
    titleFont: font,
    labelFontSize: 11,
    titleFontSize: 12,
    titleFontWeight: 500,
  };
  return {
    background: v("bg", "#ffffff"),
    font,
    view: { stroke: "transparent" },
    mark: { color: category[0] },
    axis,
    axisX: { labelAngle: 0, labelOverlap: true },
    legend: { labelColor: muted, titleColor: fg, labelFont: font, titleFont: font },
    title: { color: fg, subtitleColor: muted, font, fontWeight: 600 },
    header: { labelColor: muted, titleColor: fg, labelFont: font, titleFont: font },
    // Magnitude stays a grey ramp, from the strong rule to the ink.
    range: { category, ordinal: category, ramp: [greys[3], fg] },
  };
}

/**
 * A single view with no width of its own is drawn at `width` (the reader's column, or the render
 * width), its padding inside it; compositions and charts that set a width keep theirs.
 */
export function sizedChart(spec: ChartSpec, width: number): ChartSpec {
  const composed = ["layer", "concat", "hconcat", "vconcat", "facet", "repeat"].some(
    (k) => spec[k] !== undefined,
  );
  if (width <= 0 || spec.width !== undefined || (composed && spec.layer === undefined)) return spec;
  return { autosize: { type: "fit-x", contains: "padding" }, ...spec, width };
}
