/**
 * Drawn diagrams in exports (TEMPRA-168; tempra-dev: app/media, Diagrams): a downloaded bundle
 * carries, beside each page with Mermaid or SVG fences, `<page>.diagrams/<n>.svg`: for
 * Mermaid the light SVG the render Worker draws (its R2 cache makes an unchanged fence cost
 * nothing), for an SVG fence its sanitized SVG, made here (TEMPRA-206); numbered as the
 * reader numbers figures (`findFigures`). Derived, never written into the page, and ignored
 * on import. A fence that does not draw, or a render service that is not there, is left out
 * without a word: the export never fails for a diagram. Bounded by MAX_EXPORT_DIAGRAMS, a time
 * budget and a few renders at a time. Free of Worker APIs.
 */
import { FIGURE_FENCES, findFigures, parseMarkdown, sanitizeSvg } from "@tempra/editor/doc";
import { chartForRender } from "./chart-data";
import { splitFrontmatter } from "./format/page";
import { RENDER_WIDTH, type RenderContext, type RenderDiagram } from "./render";

/** The most diagrams one export draws; past it the rest are left out. */
export const MAX_EXPORT_DIAGRAMS = 500;
/** How long one export spends drawing, in all; what is not drawn by then is left out. */
export const EXPORT_DIAGRAMS_MS = 60_000;
/** Renders in flight at once. */
export const EXPORT_RENDER_CONCURRENCY = 4;

export interface DiagramExport {
  /** Draws Mermaid and charts; without it only SVG fences are exported. */
  render?: RenderDiagram;
  /** A bundle file's text, for a chart's data (TEMPRA-207); without it, charts with data files are left out. */
  read?: (path: string) => Promise<string | null>;
  /** Whose renders these are, for metering. */
  ctx: RenderContext;
  max?: number;
  budgetMs?: number;
  concurrency?: number;
}

const DERIVED = /^(.*)\.diagrams\/\d+\.svg$/;
const HAS_FENCE = /(?:`{3,}|~{3,})[ \t]*(?:mermaid|svg|vega-lite)/i;

/** Where a page's drawn diagrams go: `a/b.md` → `a/b.diagrams/`. */
export function diagramsDir(pagePath: string): string {
  return `${pagePath.replace(/\.md$/, "")}.diagrams/`;
}

/** Whether a bundle path is a drawn diagram beside one of `pages` (paths ending .md). */
export function isDrawnDiagram(path: string, pages: ReadonlySet<string>): boolean {
  const m = DERIVED.exec(path);
  return !!m && pages.has(`${m[1]}.md`);
}

/** A fence to export: where it goes, its source and its language. */
export interface DiagramJob {
  path: string;
  source: string;
  lang: string;
  /** The page it is in, where a chart's data paths resolve from. */
  page: string;
}

/** The drawn fences of a bundle's pages, as export paths and sources, in bundle order. */
export function diagramJobs(files: { path: string; text?: string }[]): DiagramJob[] {
  const taken = new Set(files.map((f) => f.path));
  const jobs: DiagramJob[] = [];
  for (const f of files) {
    if (f.text === undefined || !f.path.endsWith(".md") || !HAS_FENCE.test(f.text)) continue;
    const dir = diagramsDir(f.path);
    for (const fig of findFigures(parseMarkdown(splitFrontmatter(f.text).body))) {
      if (fig.kind !== "diagram" || !FIGURE_FENCES.has((fig.node.lang ?? "").toLowerCase())) {
        continue;
      }
      const path = `${dir}${fig.n}.svg`;
      // A real file at that path is the library's own; keep it and draw nothing over it.
      if (!taken.has(path) && fig.node.value.trim()) {
        jobs.push({
          path,
          source: fig.node.value,
          lang: (fig.node.lang ?? "").toLowerCase(),
          page: f.path,
        });
      }
    }
  }
  return jobs;
}

/** Draws a bundle's diagrams as SVG files; what fails or runs out of budget is left out. */
export async function drawnDiagrams(
  files: { path: string; text?: string }[],
  opts: DiagramExport,
): Promise<{ path: string; svg: string }[]> {
  const jobs = diagramJobs(files).slice(0, opts.max ?? MAX_EXPORT_DIAGRAMS);
  if (jobs.length === 0) return [];
  const drawn: (string | undefined)[] = new Array(jobs.length);
  // SVG fences need no renderer: their sanitized SVG is the drawing.
  for (const [i, job] of jobs.entries()) {
    if (job.lang !== "svg") continue;
    const r = sanitizeSvg(job.source);
    if (r.ok) drawn[i] = r.svg;
  }
  const render = opts.render;
  const queue = render
    ? [...jobs.keys()].filter((i) => jobs[i]?.lang === "mermaid" || jobs[i]?.lang === "vega-lite")
    : [];
  let next = 0;
  let over = false;
  const worker = async () => {
    while (!over && next < queue.length && render) {
      const i = queue[next++] as number;
      const job = jobs[i] as DiagramJob;
      let source = job.source;
      if (job.lang === "vega-lite") {
        const chart = await chartForRender(source, job.page, opts.read ?? (async () => null));
        if (!chart.ok) continue;
        source = chart.source;
      }
      const lang = job.lang === "vega-lite" ? ({ lang: "vega-lite" } as const) : {};
      const r = await render({ source, ...lang, width: RENDER_WIDTH, theme: "light" }, opts.ctx);
      if (!over && r.svg && !r.error) drawn[i] = r.svg;
    }
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const pool = Promise.all(
    Array.from(
      { length: Math.min(opts.concurrency ?? EXPORT_RENDER_CONCURRENCY, queue.length) },
      worker,
    ),
  );
  await Promise.race([
    pool,
    new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        over = true;
        resolve();
      }, opts.budgetMs ?? EXPORT_DIAGRAMS_MS);
    }),
  ]);
  over = true;
  if (timer !== undefined) clearTimeout(timer);
  const out: { path: string; svg: string }[] = [];
  for (const [i, svg] of drawn.entries()) {
    const job = jobs[i];
    if (svg !== undefined && job) out.push({ path: job.path, svg });
  }
  return out;
}
