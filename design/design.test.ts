import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { generate, generatePanel, generatePele } from "./build";
import { css, fonts, hash, href } from "./dist/tempra";

test("dist/ is up to date with src/ (run `bun run build` in design/)", () => {
  const fresh = generate();
  expect(readFileSync(join(import.meta.dir, "dist", "tempra.css"), "utf8")).toBe(fresh.css);
  expect(readFileSync(join(import.meta.dir, "dist", "tempra.ts"), "utf8")).toBe(fresh.ts);
  expect(readFileSync(join(import.meta.dir, "dist", "pele.ts"), "utf8")).toBe(generatePele());
  expect(readFileSync(join(import.meta.dir, "dist", "panel.ts"), "utf8")).toBe(generatePanel());
});

test("the diagram theme resolves every --pele-* to a concrete value, light and dark (TEMPRA-165)", async () => {
  const { peleThemes } = await import("./dist/pele");
  for (const scheme of ["light", "dark"] as const) {
    const t = peleThemes[scheme];
    expect(Object.keys(t).length).toBeGreaterThan(10);
    for (const v of Object.values(t)) expect(v).not.toMatch(/var\(|light-dark\(/);
  }
  expect(peleThemes.light["--pele-bg"]).toBe("#ffffff");
  expect(peleThemes.dark["--pele-fg"]).not.toBe(peleThemes.light["--pele-fg"]);
});

test("the stylesheet carries tokens, base and prose, and a hashed URL", () => {
  expect(css).toContain("--tempra-color-text");
  expect(css).toContain("light-dark(");
  expect(css).toContain(".prose");
  expect(hash).toMatch(/^[0-9a-f]{12}$/);
  expect(href).toBe(`/_design/tempra.${hash}.css`);
});

test("every font the stylesheets name exists: in the package for the site, served for the app", () => {
  const site = readFileSync(join(import.meta.dir, "dist", "tempra.css"), "utf8");
  for (const [, file] of site.matchAll(/url\("\.\.\/fonts\/([^"]+)"\)/g)) {
    expect(readFileSync(join(import.meta.dir, "fonts", file as string)).byteLength).toBeGreaterThan(
      0,
    );
  }
  const served = [...css.matchAll(/url\("\/_design\/([^"]+)"\)/g)].map((m) => m[1] as string);
  expect(served.length).toBeGreaterThan(0);
  expect(served.sort()).toEqual(Object.keys(fonts).sort());
  expect(css).not.toContain("../fonts/");
});

test("an SVG figure's text inherits the reader's font from its container, never forced on the svg (TEMPRA-216)", () => {
  const reader = readFileSync(join(import.meta.dir, "src", "reader.css"), "utf8");
  const block = (selector: string) =>
    new RegExp(`(?:^|\\n)${selector.replace(/[.*]/g, "\\$&")}\\s*\\{([^}]*)\\}`).exec(
      reader,
    )?.[1] ?? "";
  expect(block(".prose .diagram-svg")).toContain("font-family: var(--tempra-font-text);");
  expect(block(".lightbox-diagram")).toContain("font-family: var(--tempra-font-text);");
  // On the svg itself it would override an author's font-family on the root.
  expect(block(".prose .diagram-svg svg")).not.toContain("font-family");
  expect(block(".lightbox-diagram svg")).not.toContain("font-family");
});

// Token hygiene (TEMPRA-227): every token a stylesheet reads is defined.
test("every --tempra-* a stylesheet reads is defined", () => {
  const src = (f: string) => readFileSync(join(import.meta.dir, "src", f), "utf8");
  const tokens = src("tokens.css");
  const names = (text: string) =>
    new Set([...text.matchAll(/^\s*(--tempra-[a-z0-9-]+):/gm)].map((m) => m[1] as string));
  const defined = names(tokens);
  const sheets = [
    "tokens.css",
    "fonts.css",
    "base.css",
    "prose.css",
    "reader.css",
    "workspace.css",
    "concept.css",
    "comments.css",
    "views.css",
    "public.css",
    "panel.css",
  ];
  for (const f of sheets) {
    for (const [, name] of src(f).matchAll(/var\((--tempra-[a-z0-9-]+)/g)) {
      expect(defined.has(name as string), `${f} reads ${name}`).toBe(true);
    }
  }
});

// Two tiers: the palette's primitives hold the raw colours, the colour roles point at them, and
// only tokens.css reads a primitive, so a theme or the palette changes in one place.
const PRIMITIVE =
  /^--tempra-(white|black|grey-(warm|cool)|orange|blue|aqua|yellow|magenta|green|violet|red)(-|$)/;

test("colour roles point at palette primitives, never at raw values", () => {
  const tokens = readFileSync(join(import.meta.dir, "src", "tokens.css"), "utf8").replace(
    /\/\*[\s\S]*?\*\//g,
    "",
  );
  for (const [, name, value] of tokens.matchAll(/^\s*(--tempra-[a-z0-9-]+):\s*([^;]+);/gm)) {
    const n = name as string;
    const v = value as string;
    if (PRIMITIVE.test(n)) {
      expect(v, `${n} is a raw colour`).toMatch(/^#[0-9a-f]{6}$/);
    } else if (n.startsWith("--tempra-color-") && /light-dark\(/.test(v)) {
      // The scrim's and the shadow's see-through blacks stay literal until the palette.
      if (n === "--tempra-color-scrim") continue;
      expect(v, `${n} names a raw colour`).not.toMatch(/#[0-9a-f]{3,8}\b|rgb\(|hsl\(|oklch\(/i);
    }
  }
});

test("only tokens.css reads a palette primitive", () => {
  const src = (f: string) => readFileSync(join(import.meta.dir, "src", f), "utf8");
  for (const f of [
    "fonts.css",
    "base.css",
    "prose.css",
    "reader.css",
    "workspace.css",
    "concept.css",
    "comments.css",
    "views.css",
    "public.css",
    "panel.css",
  ]) {
    for (const [, name] of src(f).matchAll(/var\((--tempra-[a-z0-9-]+)/g)) {
      expect(PRIMITIVE.test(name as string), `${f} reads the primitive ${name}`).toBe(false);
    }
  }
});
