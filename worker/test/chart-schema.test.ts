import { describe, expect, test } from "bun:test";
import { schemaText } from "../scripts/vega-lite-schema";
import { checkChartSpec } from "../src/format/chart-schema";
import { VEGA_LITE_SCHEMA_JSON } from "../src/format/vega-lite-schema";

const values = [
  { day: "Mon", p50: 40, p99: 78, when: "2026-10-01" },
  { day: "Tue", p50: 52, p99: 79, when: "2026-10-02" },
];

/** Specs Vega-Lite draws: the schema check must take every one (no false lint). */
const VALID: Record<string, unknown> = {
  bar: {
    $schema: "https://vega.github.io/schema/vega-lite/v6.json",
    description: "p50 by day",
    data: { values },
    mark: "bar",
    encoding: {
      x: { field: "day", type: "ordinal", sort: null, axis: { labelAngle: 0 } },
      y: { field: "p50", type: "quantitative", title: "Latency (ms)" },
    },
  },
  library: {
    data: { url: "/data/sales.csv" },
    width: "container",
    height: 240,
    mark: { type: "line", point: true, tooltip: true },
    encoding: {
      x: { field: "when", type: "temporal", timeUnit: "yearmonthdate" },
      y: { aggregate: "sum", field: "v", type: "quantitative" },
      color: { field: "series", type: "nominal", legend: { orient: "bottom" } },
      tooltip: [{ field: "v", type: "quantitative", format: ",.0f" }],
    },
  },
  csv: {
    data: { values: "a,b\n1,2\n", format: { type: "csv" } },
    mark: "point",
    encoding: { x: { field: "a", type: "quantitative", bin: true }, y: { aggregate: "count" } },
  },
  fold: {
    data: { values },
    transform: [
      { fold: ["p50", "p99"], as: ["series", "ms"] },
      { filter: "datum.ms > 0" },
      { calculate: "datum.ms / 1000", as: "s" },
    ],
    mark: "line",
    encoding: {
      x: { field: "day", type: "ordinal" },
      y: { field: "s", type: "quantitative", scale: { zero: false } },
      color: { field: "series", type: "nominal" },
      strokeDash: { field: "series", type: "nominal" },
    },
  },
  layer: {
    data: { values },
    encoding: { x: { field: "day", type: "ordinal" } },
    layer: [
      { mark: "line", encoding: { y: { field: "p50", type: "quantitative" } } },
      { mark: { type: "rule", color: "currentColor" }, encoding: { y: { datum: 50 } } },
      {
        mark: { type: "text", dy: -8 },
        encoding: { y: { field: "p99", type: "quantitative" }, text: { field: "p99" } },
      },
    ],
  },
  facet: {
    data: { values },
    facet: { row: { field: "day", type: "nominal" } },
    spec: { mark: "bar", encoding: { x: { field: "p50", type: "quantitative" } } },
  },
  repeat: {
    data: { values },
    repeat: ["p50", "p99"],
    spec: {
      mark: "bar",
      encoding: {
        x: { field: "day", type: "ordinal" },
        y: { field: { repeat: "repeat" }, type: "quantitative" },
      },
    },
  },
  concat: {
    data: { values },
    hconcat: [
      { mark: "bar", encoding: { x: { field: "day", type: "nominal" } } },
      { mark: "arc", encoding: { theta: { field: "p50", type: "quantitative" } } },
    ],
    resolve: { scale: { color: "independent" } },
  },
  params: {
    data: { values },
    params: [{ name: "pick", select: { type: "point", fields: ["day"] }, bind: "legend" }],
    mark: "bar",
    encoding: {
      x: { field: "day", type: "nominal" },
      y: { field: "p50", type: "quantitative" },
      opacity: { condition: { param: "pick", value: 1 }, value: 0.3 },
    },
    config: { axis: { grid: false }, view: { stroke: null } },
  },
  boxplot: {
    data: { values },
    mark: { type: "boxplot", extent: "min-max" },
    encoding: { y: { field: "p50", type: "quantitative" } },
  },
};

describe("Vega-Lite's schema on write (TEMPRA-214)", () => {
  test("the bundled schema is the pinned Vega-Lite's", async () => {
    // Stale after moving Vega-Lite: run `bun scripts/vega-lite-schema.ts` from worker/.
    expect(VEGA_LITE_SCHEMA_JSON === (await schemaText())).toBe(true);
  });

  test("specs Vega-Lite takes are taken", () => {
    for (const [name, spec] of Object.entries(VALID)) {
      expect({ name, problems: checkChartSpec(spec) }).toEqual({ name, problems: [] });
    }
  });

  test("what is wrong, at its path, in words: values it could be, typos named", () => {
    expect(
      checkChartSpec({ mark: "notamark", encoding: { x: { field: "a", type: "bogus" } } }),
    ).toEqual([
      { path: "", message: 'has no "data", which it needs' },
      {
        path: "mark",
        message:
          '"notamark" is not one of "boxplot", "errorbar", "errorband", "arc", "area", "bar", "image", "line", "point", "rect", "rule", "text", … or an object',
      },
      {
        path: "encoding.x.type",
        message: '"bogus" is not one of "quantitative", "ordinal", "temporal" or "nominal"',
      },
    ]);
    const data = { values };
    expect(checkChartSpec({ data, mark: "bar", encoding: { colr: { field: "a" } } })).toEqual([
      { path: "encoding", message: '"colr" is not a property here (did you mean "color"?)' },
    ]);
    expect(
      checkChartSpec({
        data,
        layer: [{ mark: "line", encoding: { x: { field: "a", timeUnit: "yeer" } } }],
      })[0],
    ).toMatchObject({
      path: "layer[0].encoding.x.timeUnit",
      message: expect.stringContaining('(did you mean "year"?)'),
    });
    expect(
      checkChartSpec({
        data,
        mark: "bar",
        encoding: { x: { field: "a", type: "nominal", axis: { labelAngle: "x" } } },
      }),
    ).toEqual([
      { path: "encoding.x.axis.labelAngle", message: '"x" is not a number or an object' },
    ]);
    expect(checkChartSpec({ data, mark: "bar", width: -1 })).toEqual([]);
    expect(checkChartSpec([1, 2])[0]?.message).toContain("is not");
  });

  test("at most three problems, and fast", () => {
    const spec = {
      data: { values },
      mark: "bar",
      encoding: Object.fromEntries(["a", "b", "c", "d", "e"].map((k) => [k, { field: k }])),
    };
    const t = performance.now();
    expect(checkChartSpec(spec)).toHaveLength(3);
    for (const s of Object.values(VALID)) checkChartSpec(s);
    expect(performance.now() - t).toBeLessThan(500);
  });
});
