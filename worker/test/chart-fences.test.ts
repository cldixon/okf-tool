/**
 * Vega-Lite fences as rendered media (TEMPRA-207; tempra-dev: app/diagrams, app/media): lint on
 * write and from the render service, data from the library made inline for `render`, `read` and
 * exports, and the render Worker drawing with Vega under the same rule Workers keep (no
 * `new Function`, no network).
 */
import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { chartSeries } from "@tempra/design/pele";
import { chartSvg } from "../render/src/chart";
import { cacheKey } from "../render/src/render";
import { fakeRenderer, type RenderRequest } from "../src/render";
import { readTar } from "../src/util/tar";
import { setup } from "./harness";

const doc = (body: string) =>
  `---\ntype: Figure Test\ntitle: C\ndescription: Charts.\nstatus: draft\n---\n${body}`;
const fence = (spec: unknown, meta = 'alt="Sales by month"') =>
  `\`\`\`vega-lite ${meta}\n${typeof spec === "string" ? spec : JSON.stringify(spec, null, 2)}\n\`\`\`\n`;
const BAR = {
  data: { url: "/data/sales.csv" },
  mark: "bar",
  encoding: {
    x: { field: "month", type: "ordinal" },
    y: { field: "v", type: "quantitative" },
  },
};
const CSV = "month,v\nJan,3\nFeb,5\n";

type Text = { type: "text"; text: string };

async function connect(app: ReturnType<typeof setup>["app"]) {
  const transport = new StreamableHTTPClientTransport(new URL("http://localhost/mcp"), {
    requestInit: { headers: { Authorization: "Bearer writer" } },
    fetch: async (url, init) => app.request(url.toString(), init as RequestInit),
  });
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(transport);
  return async (name: string, args: Record<string, unknown> = {}) => {
    const r = await client.callTool({ name, arguments: args });
    const content = r.content as (Text | { type: "image" })[];
    return {
      content,
      text: content.map((c) => ("text" in c ? c.text : "")).join("\n"),
      isError: !!r.isError,
    };
  };
}

async function withData(s: ReturnType<typeof setup>) {
  const put = await s.req("/files/data/sales.csv", {
    method: "PUT",
    body: CSV,
    headers: { "Content-Type": "text/csv" },
  });
  expect(put.status).toBe(200);
}

const lintOf = async (s: ReturnType<typeof setup>, path: string) =>
  (
    (await (await s.req(`/files/${path}`, { headers: { Accept: "application/json" } })).json()) as {
      lint: { code: string; message: string; rendered?: boolean }[];
    }
  ).lint;

describe("Vega-Lite fences (TEMPRA-207)", () => {
  test("lint on write: not JSON, data from outside, no alt; a sound chart has none", async () => {
    const s = setup();
    const call = await connect(s.app);
    const write = async (path: string, body: string) =>
      (await call("write", { path, content: doc(body), note: "chart" })).text;
    expect(await write("ok.md", fence(BAR))).toContain("Lint: none");
    const json = await write("json.md", fence('{\n  "mark": "bar",\n}'));
    expect(json).toContain("chart_invalid");
    expect(json).toContain("Figure 1 (vega-lite, block ");
    expect(json).toContain("is not a Vega-Lite spec: it is not JSON");
    const ext = await write(
      "ext.md",
      fence({ ...BAR, data: { url: "https://example.com/sales.csv" } }),
    );
    expect(ext).toContain("data from https://example.com/sales.csv is not read");
    const noAlt = await write("noalt.md", fence(BAR, ""));
    expect(noAlt).toContain("image_no_alt");
    // A description in the spec is its alt.
    expect(await write("desc.md", fence({ ...BAR, description: "Sales" }, ""))).not.toContain(
      "image_no_alt",
    );
  });

  test("a spec Vega-Lite's schema does not take is chart_invalid in the write result, by path (TEMPRA-214)", async () => {
    const s = setup();
    await withData(s);
    const r = fakeRenderer(() => ({ svg: "<svg/>" }));
    s.deps.renderDiagram = r;
    const call = await connect(s.app);
    // The trial's fence, with the trial's page around it: a chart as Figure 2.
    const res = await call("write", {
      path: "bad.md",
      content: doc(
        `${fence(BAR)}\n${fence({ ...BAR, mark: "notamark", encoding: { x: { field: "a", type: "bogus" } } })}`,
      ),
      note: "bad chart",
    });
    expect(res.text).toContain("Figure 2 (vega-lite, block");
    expect(res.text).toContain(
      'mark: "notamark" is not one of "boxplot", "errorbar", "errorband", "arc", "area", "bar"',
    );
    expect(res.text).toContain(
      'encoding.x.type: "bogus" is not one of "quantitative", "ordinal", "temporal" or "nominal"',
    );
    // Typos are named, at any depth.
    const typo = await call("write", {
      path: "typo.md",
      content: doc(
        fence({
          ...BAR,
          encoding: { colr: { field: "v" }, x: { field: "m", type: "ordinal", timeUnit: "yeer" } },
        }),
      ),
    });
    expect(typo.text).toContain('encoding: "colr" is not a property here (did you mean "color"?)');
    // Not sent to be drawn: the write already says what is wrong.
    expect(r.calls.filter((c) => c.source.includes("notamark"))).toEqual([]);
  });

  test("Vega's verdict after the write is chart_invalid, kept beside the write's own", async () => {
    const s = setup();
    await withData(s);
    const seen: RenderRequest[] = [];
    s.deps.renderDiagram = fakeRenderer((req) => {
      seen.push(req);
      // A spec the schema takes and Vega fails on inside its own code (TEMPRA-214).
      return req.source.includes('"title":"boom"')
        ? {
            error: {
              message: "Cannot read properties of undefined (reading 'filled')",
              line: 0,
              column: 0,
            },
          }
        : { svg: "<svg/>" };
    });
    const call = await connect(s.app);
    const body = `${fence({ ...BAR, title: "boom" })}\n${fence("not json")}`;
    await call("write", { path: "c.md", content: doc(body), note: "two charts" });
    // The render Worker got the chart with its data inline, never the URL.
    const sent = seen.find((r) => r.lang === "vega-lite");
    expect(sent?.source).toContain('"values":[{"month":"Jan","v":3}');
    expect(sent?.source).not.toContain("sales.csv");
    let lint = await lintOf(s, "c.md");
    for (let i = 0; i < 50 && !lint.some((l) => l.rendered); i++) {
      await new Promise((r) => setTimeout(r, 10));
      lint = await lintOf(s, "c.md");
    }
    const charts = lint.filter((l) => l.code === "chart_invalid");
    expect(charts.map((l) => !!l.rendered).sort()).toEqual([false, true]);
    expect(charts.find((l) => l.rendered)?.message).toContain("Figure 1 (vega-lite, block ");
    expect(charts.find((l) => l.rendered)?.message).toContain(
      "could not be drawn by Vega: Vega failed inside its own code, which a spec it does not understand can cause (an unknown mark, channel, field type or transform; check them against Vega-Lite's). Vega said: Cannot read properties of undefined (reading 'filled').",
    );
    // An edit elsewhere keeps both: the verdict is known by the source's hash.
    await call("edit", { path: "c.md", edits: [{ old: "C", new: "C2" }] });
    expect((await lintOf(s, "c.md")).filter((l) => l.code === "chart_invalid")).toHaveLength(2);
  });

  test("render and read draw charts with their data inline; data that cannot be read is said", async () => {
    const s = setup();
    await withData(s);
    const r = fakeRenderer((req) => ({
      svg: "<svg/>",
      png: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
    }));
    s.deps.renderDiagram = r;
    const call = await connect(s.app);
    await call("write", {
      path: "notes/c.md",
      content: doc(fence(BAR, 'alt="Sales" title="By month"')),
    });
    expect((await call("read", { path: "notes/c.md" })).text).toContain(
      'Figure 1 · diagram (vega-lite) · alt "Sales" · caption "By month"',
    );
    const drawn = await call("read", { path: "notes/c.md", diagrams: true });
    expect(drawn.content.some((c) => c.type === "image")).toBe(true);
    expect(r.calls.at(-1)).toMatchObject({ lang: "vega-lite", png: true });
    expect(r.calls.at(-1)?.source).toContain('"values"');
    const byFigure = await call("render", { path: "notes/c.md", figure: 1 });
    expect(byFigure.text).toContain("· vega-lite · light");
    expect(byFigure.content[1]?.type).toBe("image");
    // A source with a path relative to the library's root.
    expect(
      (await call("render", { source: JSON.stringify(BAR), lang: "vega-lite" })).content[1]?.type,
    ).toBe("image");
    const missing = await call("render", {
      source: JSON.stringify({ ...BAR, data: { url: "/nope.csv" } }),
      lang: "vega-lite",
    });
    expect(missing.text).toContain(
      "Vega could not draw it: The chart's data: no file at /nope.csv",
    );
    // Told from the source with no lang (TEMPRA-213), and checked by the write's rules: data
    // from elsewhere is never fetched, so it is not drawn and says why.
    const calls = r.calls.length;
    const told = await call("render", { source: JSON.stringify(BAR) });
    expect(told.text).toContain("Diagram · vega-lite · light");
    expect(told.content[1]?.type).toBe("image");
    const away = await call("render", {
      source: JSON.stringify({ ...BAR, data: { url: "https://example.com/x.csv" } }),
    });
    expect(away.text).toContain("Not drawn.\nA write would report:\n- chart_invalid: The chart");
    expect(away.text).toContain("https://example.com/x.csv");
    const notJson = await call("render", { source: "{nope", lang: "vega-lite" });
    expect(notJson.text).toContain("- chart_invalid: The chart is not a Vega-Lite spec");
    expect(r.calls.length).toBe(calls + 1);
    const noAlt = await call("render", { source: fence(BAR, "") });
    expect(noAlt.text).toContain("- image_no_alt: The chart has no alt text");
  });

  test("exports draw charts with their data from the bundle", async () => {
    const s = setup();
    await withData(s);
    const r = fakeRenderer((req) => ({ svg: `<svg data-lang="${req.lang ?? "mermaid"}"/>` }));
    s.deps.renderDiagram = r;
    expect((await s.req("/files/n/c.md", { method: "PUT", body: doc(fence(BAR)) })).status).toBe(
      200,
    );
    const out = new Map(
      readTar(new Uint8Array(await (await s.req("/export")).arrayBuffer())).map((f) => [
        f.path,
        new TextDecoder().decode(f.bytes),
      ]),
    );
    expect(out.get("n/c.diagrams/1.svg")).toBe('<svg data-lang="vega-lite"/>');
    expect(r.calls.find((c) => c.lang === "vega-lite")?.source).toContain('"month":"Feb"');
  });

  test("the render Worker draws with Vega, no new Function, nothing loaded, sanitized", async () => {
    const real = globalThis.Function;
    globalThis.Function = (() => {
      throw new Error("new Function is not allowed");
    }) as unknown as FunctionConstructor;
    let svg: string;
    try {
      svg = await chartSvg(
        JSON.stringify({
          data: { values: [{ m: "Jan", v: 3, u: "https://example.com/" }] },
          mark: "bar",
          transform: [{ calculate: "datum.v * 2", as: "w" }],
          encoding: {
            x: { field: "m", type: "ordinal" },
            y: { field: "w", type: "quantitative" },
            href: { field: "u" },
          },
        }),
        "dark",
        400,
      );
    } finally {
      globalThis.Function = real;
    }
    expect(svg).toStartWith('<svg xmlns="http://www.w3.org/2000/svg"');
    expect(svg).toContain("<path");
    // The href encoding's link is taken out; the dark theme's ground is drawn.
    expect(svg).not.toContain("example.com");
    expect(svg).toContain("#09090b");
    await expect(
      chartSvg(JSON.stringify({ data: { url: "/x.csv" }, mark: "bar" }), "light", 0),
    ).rejects.toThrow("not made inline");
    await expect(chartSvg(JSON.stringify({ mark: "bra" }), "light", 0)).rejects.toThrow();
    expect(cacheKey("h", "light", 680, "svg", "vega-lite")).toContain("/vl-");
  });

  test("series in the chart colours of each scheme, weekdays level on a wide chart (TEMPRA-217)", async () => {
    const days = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
    const spec = JSON.stringify({
      data: {
        values: ["p50", "p99"].flatMap((q, i) =>
          days.map((day, j) => ({ day, q, ms: 10 * i + j })),
        ),
      },
      mark: "line",
      encoding: {
        x: { field: "day", type: "nominal", sort: days },
        y: { field: "ms", type: "quantitative" },
        color: { field: "q", type: "nominal" },
      },
    });
    for (const theme of ["light", "dark"] as const) {
      const svg = await chartSvg(spec, theme, 1360);
      const [one, two] = chartSeries[theme] as [string, string];
      expect(svg).toContain(`stroke="${one}"`);
      expect(svg).toContain(`stroke="${two}"`);
      // Vega draws a turned label with rotate(); the weekdays are not turned.
      expect(svg).not.toMatch(/rotate\((?:270|-90|90|315|-45)\)[^>]*>(?:<[^>]*>)*(?:Mon|Tue)/);
      for (const d of days) expect(svg).toContain(`>${d}<`);
    }
  });
});
