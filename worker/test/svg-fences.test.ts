/**
 * SVG fences as rendered media (TEMPRA-206; tempra-dev: app/diagrams, app/media): lint on write,
 * figures in `read`, the render tool and drawn figures for agents, the render client sanitizing
 * before the render Worker, the render Worker's drawing, and exports.
 */
import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { FONT, pageFor, type RenderCache, renderDiagram, svgFigure } from "../render/src/render";
import { type RenderService, serviceRenderer } from "../src/render";
import { readTar } from "../src/util/tar";
import { setup } from "./harness";

const attr = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;");

const SVG = '<svg viewBox="0 0 20 10"><title>Two squares</title><rect width="5" height="5"/></svg>';
const UNSAFE = '<svg viewBox="0 0 2 2" onload="x()"><script>x()</script><circle r="1"/></svg>';
const doc = (body: string) =>
  `---\ntype: Figure Test\ntitle: S\ndescription: SVG.\nstatus: draft\n---\n${body}`;
const fence = (src: string, meta = "") => `\`\`\`svg${meta ? ` ${meta}` : ""}\n${src}\n\`\`\`\n`;

type Text = { type: "text"; text: string };

async function connect(app: ReturnType<typeof setup>["app"]) {
  const transport = new StreamableHTTPClientTransport(new URL("http://localhost/mcp"), {
    requestInit: { headers: { Authorization: "Bearer writer" } },
    fetch: async (url, init) => app.request(url.toString(), init as RequestInit),
  });
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(transport);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await client.callTool({ name, arguments: args });
    return {
      content: r.content as (Text | { type: "image"; data: string; mimeType: string })[],
      text: (r.content as Text[]).map((c) => c.text ?? "").join("\n"),
      isError: !!r.isError,
    };
  };
  return { call };
}

const codes = (lint: { code: string }[]) => lint.map((l) => l.code).sort();

describe("SVG fences (TEMPRA-206)", () => {
  test("lint on write: invalid, unsafe and without alt; a clean one has none", async () => {
    const s = setup();
    const { call } = await connect(s.app);
    const write = async (path: string, body: string) => {
      const r = await call("write", { path, content: doc(body), note: "svg" });
      expect(r.isError).toBe(false);
      return r.text;
    };
    expect(await write("ok.md", fence(SVG))).toContain("Lint: none");
    const bad = await write("bad.md", fence("<svg><rect></svg>", 'alt="x"'));
    expect(bad).toContain("svg_invalid");
    expect(bad).toContain("Figure 1 (svg, block ");
    expect(bad).toContain("does not parse at line 1, column 12 of the fence: </svg> closes <rect>");
    const unsafe = await write("unsafe.md", fence(UNSAFE));
    expect(unsafe).toContain("svg_unsafe");
    expect(unsafe).toContain("scripts");
    expect(unsafe).toContain("event handlers");
    expect(unsafe).toContain("image_no_alt");
    const res = (await (
      await s.req("/files/unsafe.md", { headers: { Accept: "application/json" } })
    ).json()) as { lint: { code: string }[] };
    expect(codes(res.lint)).toEqual(["image_no_alt", "svg_unsafe"]);
    // The fence's alt says what it shows.
    expect(
      await write("alt.md", fence(UNSAFE.replace('onload="x()"', ""), 'alt="A dot"')),
    ).not.toContain("image_no_alt");
  });

  test("read lists it as a figure with its alt; render and diagrams: true draw it sanitized", async () => {
    const s = setup();
    // The real client around a recording render Worker: what it is sent is what is drawn.
    const sent: { source: string; lang?: string; png?: boolean }[] = [];
    s.deps.renderDiagram = serviceRenderer({
      async render(req) {
        sent.push(req);
        return {
          svg: req.source,
          ...(req.png ? { png: new Uint8Array([0x89, 0x50, 0x4e, 0x47]) } : {}),
        };
      },
    });
    const { call } = await connect(s.app);
    await call("write", {
      path: "f.md",
      content: doc(`Intro.\n\n${fence(UNSAFE, 'alt="A dot" title="The dot"')}`),
    });
    const read = await call("read", { path: "f.md" });
    expect(read.text).toContain('Figure 1 · diagram (svg) · alt "A dot" · caption "The dot"');
    const drawn = await call("read", { path: "f.md", diagrams: true });
    expect(drawn.content.some((c) => c.type === "image")).toBe(true);
    // The render Worker is sent the sanitized SVG, never the fence as written.
    expect(sent.at(-1)).toMatchObject({
      lang: "svg",
      source: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 2 2"><circle r="1"/></svg>',
      png: true,
    });
    const byFigure = await call("render", { path: "f.md", figure: 1 });
    expect(byFigure.content[0]).toMatchObject({ type: "text" });
    expect((byFigure.content[0] as Text).text).toContain(
      'Figure 1 of /f.md ("The dot") · svg · light',
    );
    expect(byFigure.content[1]?.type).toBe("image");
    // A source, by lang or as a pasted fence.
    expect((await call("render", { source: SVG, lang: "svg" })).content[1]?.type).toBe("image");
    expect((await call("render", { source: fence(SVG) })).text).toContain("· svg ·");
    // Before it is written (TEMPRA-213): told from the source with no lang, and checked as a
    // write would check it, what a write would report said with the drawing.
    const before = sent.length;
    const told = await call("render", { source: UNSAFE });
    expect(told.content[1]?.type).toBe("image");
    expect(sent.length).toBe(before + 1);
    const said = (told.content[0] as Text).text;
    expect(said).toContain("Diagram · svg · light");
    expect(said).toContain("A write would report:\n- svg_unsafe: The SVG is drawn without");
    expect(said).toContain("event handlers, scripts");
    // Alt text lives on the fence's header, so it is asked for only when the fence is given.
    expect(said).not.toContain("image_no_alt");
    expect((await call("render", { source: fence(UNSAFE) })).text).toContain(
      "- image_no_alt: The SVG has no alt text",
    );
    expect((await call("render", { source: fence(SVG) })).text).not.toContain("A write would");
    // One a write would call invalid is not sent to be drawn.
    const broken = await call("render", { source: "<svg><g></svg>", lang: "svg" });
    expect(broken.text).toContain(
      "Not drawn.\nA write would report:\n- svg_invalid: The SVG does not parse at line 1, column 9 of the fence: </svg> closes <g>.",
    );
    expect(sent.length).toBe(before + 3);
  });

  test("the render client sanitizes before the render Worker, and passes lang", async () => {
    const seen: unknown[] = [];
    const service: RenderService = {
      async render(req) {
        seen.push(req);
        return { svg: req.source };
      },
    };
    const render = serviceRenderer(service);
    await render({ source: UNSAFE, lang: "svg", theme: "light" }, { account: "a" });
    expect(seen).toEqual([
      {
        source: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 2 2"><circle r="1"/></svg>',
        lang: "svg",
        theme: "light",
        width: undefined,
        png: false,
      },
    ]);
    const bad = await render({ source: "<svg>", lang: "svg", theme: "light" }, { account: "a" });
    expect(bad.error).toMatchObject({
      message: "The SVG does not parse: <svg> is not closed.",
      line: 1,
    });
    expect(seen).toHaveLength(1);
  });

  test("the render Worker draws a sanitized SVG at its size, scaled to the width, in the theme's ink", async () => {
    const pages: { html: string; width: number; height: number }[] = [];
    const objects = new Map<string, string | Uint8Array>();
    const cache: RenderCache = {
      async get(key) {
        const v = objects.get(key);
        if (v === undefined) return null;
        return {
          text: async () => (typeof v === "string" ? v : new TextDecoder().decode(v)),
          arrayBuffer: async () =>
            (typeof v === "string" ? new TextEncoder().encode(v) : v).slice().buffer as ArrayBuffer,
        };
      },
      async put(key, value) {
        objects.set(key, value);
      },
    };
    const deps = {
      cache,
      rasterizer: {
        async png(html: string, size: { width: number; height: number }) {
          pages.push({ html, ...size });
          return new Uint8Array([0x89]);
        },
      },
    };
    const source =
      '<svg xmlns="http://www.w3.org/2000/svg" width="1360" height="200" viewBox="0 0 1360 200"><rect width="10" height="10" fill="currentColor"/></svg>';
    const r = await renderDiagram(
      { source, lang: "svg", theme: "dark", width: 680, png: true },
      deps,
    );
    expect(r.error).toBeUndefined();
    expect(r.svg).toStartWith('<svg width="680" height="100" color="');
    expect(pages[0]).toMatchObject({ width: 680, height: 100 });
    expect([...objects.keys()].every((k) => k.includes("/svg-2/"))).toBe(true);
    expect(() => svgFigure("<svg><script>x()</script></svg>", "light", 0)).toThrow("not sanitized");
  });

  test("the render Worker draws an SVG fence's text in the reader's Inter, unless the author chose (TEMPRA-216)", () => {
    const plain = svgFigure(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 10"><text y="8">a</text></svg>',
      "light",
      0,
    );
    expect(plain).toStartWith(
      `<svg width="20" height="10" color="#161618" font-family="${attr(FONT)}"`,
    );
    expect(FONT).toStartWith('"Inter"');
    const own = svgFigure(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 10" font-family="Georgia"><text y="8">a</text></svg>',
      "light",
      0,
    );
    expect(own).toContain(' font-family="Georgia"');
    expect(own.match(/font-family=/g)).toHaveLength(1);
    // The page around it is in Inter as well, so no text falls back to the browser's serif.
    expect(pageFor(plain, "dark")).toContain(`font-family:${FONT}}`);
  });

  test("exports carry a sanitized SVG beside the concept, with no renderer needed", async () => {
    const s = setup();
    s.deps.renderDiagram = undefined;
    const body = `![x](/pic.png)\n\n${fence(UNSAFE)}\n\`\`\`mermaid\nflowchart LR\n  A --> B\n\`\`\`\n`;
    expect((await s.req("/files/n/a.md", { method: "PUT", body: doc(body) })).status).toBe(200);
    const r = await s.req("/export");
    const out = new Map(
      readTar(new Uint8Array(await r.arrayBuffer())).map((f) => [
        f.path,
        new TextDecoder().decode(f.bytes),
      ]),
    );
    // Figure 1 is the image, 2 the SVG fence; the Mermaid one needs the renderer it lacks.
    expect([...out.keys()].filter((p) => p.includes(".diagrams/"))).toEqual(["n/a.diagrams/2.svg"]);
    expect(out.get("n/a.diagrams/2.svg")).toBe(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 2 2"><circle r="1"/></svg>',
    );
  });
});
