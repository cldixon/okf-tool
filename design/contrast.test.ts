import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Text people read meets WCAG AA (4.5:1) in light and dark (TEMPRA-132, X-5): the text and muted
// greys on every surface text sits on. Faint is for icons and rules only, so it is not held to it;
// the focus ring is the text colour, so it has the text's contrast.

const tokens = readFileSync(join(import.meta.dir, "src", "tokens.css"), "utf8");

/** A palette primitive's value, from `--tempra-<name>: #hex;`. */
function primitive(name: string): string {
  const m = tokens.match(new RegExp(`--${name}:\\s*(#[0-9a-f]{6});`, "i"));
  if (!m) throw new Error(`no palette value for --${name}`);
  return m[1] as string;
}

/** A colour token's light and dark values, from `--name: light-dark(var(--a), var(--b))`. */
function pair(name: string): [string, string] {
  const m = tokens.match(
    new RegExp(
      `--tempra-${name}:\\s*light-dark\\(\\s*var\\((--[a-z0-9-]+)\\),\\s*var\\((--[a-z0-9-]+)\\)\\s*\\)`,
      "i",
    ),
  );
  if (!m) throw new Error(`no light-dark() colour for --tempra-${name}`);
  return [primitive((m[1] as string).slice(2)), primitive((m[2] as string).slice(2))];
}

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const v = Number.parseInt(hex.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

const surfaces = ["color-bg", "color-ground", "color-hover", "color-selected"];
const scheme = { light: 0, dark: 1 } as const;

describe("text contrast (WCAG AA)", () => {
  test("the contrast formula", () => {
    expect(contrast("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(contrast("#777777", "#ffffff")).toBeCloseTo(4.48, 2);
  });

  for (const text of ["color-text", "color-muted"]) {
    for (const surface of surfaces) {
      for (const [mode, i] of Object.entries(scheme)) {
        test(`${text} on ${surface}, ${mode}: at least 4.5:1`, () => {
          expect(contrast(pair(text)[i], pair(surface)[i])).toBeGreaterThanOrEqual(4.5);
        });
      }
    }
  }

  // Agents' presence (TEMPRA-219): the band that moves through a name, and its static mark
  // under reduced motion, is in the words, so it is held to text's contrast.
  for (const surface of surfaces) {
    for (const [mode, i] of Object.entries(scheme)) {
      test(`color-agent-ink on ${surface}, ${mode}: at least 4.5:1`, () => {
        expect(contrast(pair("color-agent-ink")[i], pair(surface)[i])).toBeGreaterThanOrEqual(4.5);
      });
    }
  }

  // Tempra's own agent's round mark (TEMPRA-223): its letter on the agent colour.
  for (const [mode, i] of Object.entries(scheme)) {
    test(`color-on-agent on color-agent, ${mode}: at least 4.5:1`, () => {
      expect(contrast(pair("color-on-agent")[i], pair("color-agent")[i])).toBeGreaterThanOrEqual(
        4.5,
      );
    });
  }

  // Commented text (TEMPRA-223): the body's text on an open quote's fill and on the active one's,
  // and the open quote's underline seen at 3:1 (non-text contrast) on its fill and on the page.
  for (const [mode, i] of Object.entries(scheme)) {
    for (const fill of ["color-comment", "color-comment-active"]) {
      test(`color-text on ${fill}, ${mode}: at least 4.5:1`, () => {
        expect(contrast(pair("color-text")[i], pair(fill)[i])).toBeGreaterThanOrEqual(4.5);
      });
    }
    for (const under of ["color-comment", "color-bg"]) {
      test(`color-comment-line on ${under}, ${mode}: at least 3:1`, () => {
        expect(contrast(pair("color-comment-line")[i], pair(under)[i])).toBeGreaterThanOrEqual(3);
      });
    }
    test(`color-text on color-comment-active as an underline, ${mode}: at least 3:1`, () => {
      expect(
        contrast(pair("color-text")[i], pair("color-comment-active")[i]),
      ).toBeGreaterThanOrEqual(3);
    });
  }

  test("the focus ring is the text colour", () => {
    expect(tokens).toMatch(/--tempra-focus-ring:[^;]*var\(--tempra-color-text\)/);
  });
});

// Chart series (TEMPRA-217): the one set of colours beside the change dot, for a chart's series.
// Each scheme's eight are told apart by everyone (OKLab distance, x100, with no simulation) and,
// next to each other, under protanopia and deuteranopia too (Machado, Oliveira & Fernandes 2009 at
// full severity, as the dataviz skill's validator checks); each is a colour, not a grey, and stands
// off the page. Three light steps sit under 3:1 on white: a chart's legend names its series, so
// colour is never alone.

function linear(hex: string): [number, number, number] {
  return [1, 3, 5].map((i) => {
    const v = Number.parseInt(hex.slice(i, i + 2), 16) / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
}

function oklab([r, g, b]: [number, number, number]): [number, number, number] {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

const CVD = {
  protan: [
    [0.152286, 1.052583, -0.204868],
    [0.114503, 0.786281, 0.099216],
    [-0.003882, -0.048116, 1.051998],
  ],
  deutan: [
    [0.367322, 0.860646, -0.227968],
    [0.280085, 0.672501, 0.047413],
    [-0.01182, 0.04294, 0.968881],
  ],
} as const;

function seen(hex: string, sim?: keyof typeof CVD): [number, number, number] {
  const c = linear(hex);
  if (!sim) return oklab(c);
  const clamp = (v: number) => Math.min(1, Math.max(0, v));
  const [x, y, z] = CVD[sim].map((row) => clamp(row[0] * c[0] + row[1] * c[1] + row[2] * c[2])) as [
    number,
    number,
    number,
  ];
  return oklab([x, y, z]);
}

function deltaE(a: string, b: string, sim?: keyof typeof CVD): number {
  const [x, y] = [seen(a, sim), seen(b, sim)];
  return 100 * Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]);
}

describe("chart series (TEMPRA-217)", () => {
  test("the distance: black and white are 100 apart", () => {
    expect(deltaE("#000000", "#ffffff")).toBeCloseTo(100, 0);
  });

  for (const [mode, i] of Object.entries(scheme)) {
    const colours = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => pair(`color-chart-${n}`)[i]);
    const page = pair("color-bg")[i];

    test(`${mode}: eight different colours, none of them a grey`, () => {
      expect(new Set(colours).size).toBe(8);
      for (const c of colours) {
        const [, a, b] = seen(c);
        expect(Math.hypot(a, b)).toBeGreaterThanOrEqual(0.1);
      }
    });

    test(`${mode}: neighbours apart to normal vision and under protanopia and deuteranopia`, () => {
      for (let k = 0; k + 1 < colours.length; k++) {
        const [a, b] = [colours[k] as string, colours[k + 1] as string];
        expect(deltaE(a, b)).toBeGreaterThanOrEqual(15);
        expect(Math.min(deltaE(a, b, "protan"), deltaE(a, b, "deutan"))).toBeGreaterThanOrEqual(8);
      }
    });

    // Where every pair can meet (a scatter's dots), the first three are apart as neighbours are;
    // no eight hues can all be (red and orange come closest), so the eight are only never alike.
    test(`${mode}: the first three apart pair by pair; no two of the eight alike`, () => {
      const first = colours.slice(0, 3) as string[];
      for (const a of first) {
        for (const b of first) {
          if (a === b) continue;
          expect(deltaE(a, b)).toBeGreaterThanOrEqual(15);
          expect(Math.min(deltaE(a, b, "protan"), deltaE(a, b, "deutan"))).toBeGreaterThanOrEqual(
            8,
          );
        }
      }
      for (const a of colours) {
        for (const b of colours) if (a !== b) expect(deltaE(a, b)).toBeGreaterThanOrEqual(5);
      }
    });

    test(`${mode}: every series stands off the page`, () => {
      for (const c of colours) {
        expect(contrast(c, page)).toBeGreaterThanOrEqual(mode === "dark" ? 3 : 2);
      }
    });
  }
});
