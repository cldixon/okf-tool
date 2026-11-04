/**
 * The render Worker (worker/render/, TEMPRA-165) draws what the reader draws: for the same source,
 * width and id prefix, its SVG is the markup app/src/reader/pele.ts puts in the page, plus the
 * theme's `--pele-*` values on the root (which the reader gets from design/src/reader.css).
 *
 * Both measure text the same way here: with no canvas (bun, happy-dom, a Worker) Pele uses its
 * metrics. In a browser the reader measures with a canvas in the page's font, so its layout can
 * differ from the Worker's by a few pixels per label; the structure and the theme do not.
 */
import { describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { FONT, idPrefixFor, renderDiagram, sha256 } from "../worker/render/src/render";
import { diagram, svgNode } from "./src/reader/pele";

const sources = [
  "flowchart LR\n  A[Write] --> B{Parses?}\n  B -->|yes| C[Drawn]\n  style C fill:#eee",
  "sequenceDiagram\n  Alice->>Bob: Hi\n  Bob-->>Alice: Hello",
  "classDiagram\n  class Page {\n    +title\n    +read()\n  }",
  'pie title Pages\n  "Drawn" : 3\n  "Source" : 1',
];

const memory = () => {
  const m = new Map<string, string | Uint8Array>();
  return {
    get: async (k: string) => {
      const v = m.get(k);
      return v === undefined
        ? null
        : { text: async () => String(v), arrayBuffer: async () => new ArrayBuffer(0) };
    },
    put: async (k: string, v: string | Uint8Array) => {
      m.set(k, v);
    },
  };
};

describe("the render Worker's SVG is the reader's (TEMPRA-165)", () => {
  for (const source of sources) {
    for (const width of [0, 420]) {
      test(`${source.split("\n", 1)[0]} at ${width || "natural"} width`, async () => {
        const window = new Window();
        const doc = window.document as unknown as Document;
        const idPrefix = idPrefixFor(await sha256(source));
        const reader = await diagram(doc, source, { width, font: FONT, idPrefix });

        const rendered = await renderDiagram(
          { source, width, theme: "light" },
          { cache: memory(), rasterizer: { png: async () => new Uint8Array() } },
        );
        expect(rendered.error).toBeUndefined();
        const service = svgNode(rendered.svg as string, doc);
        // The theme the service adds, and nothing else, is what the reader's CSS supplies.
        const added: string[] = [];
        for (const name of Array.from(service.style)) {
          if (name.startsWith("--pele-")) added.push(name);
        }
        expect(added.length).toBeGreaterThan(10);
        for (const name of added) service.style.removeProperty(name);
        expect(service.outerHTML).toBe(reader.outerHTML);
      });
    }
  }
});
