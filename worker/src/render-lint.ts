/**
 * Diagram lint from the real renderer (TEMPRA-167; tempra-dev: app/media, Diagrams): after a write
 * commits, the diagrams it added or changed that the fast checker passed (format/diagrams.ts) go to
 * the render service as SVG only, which also warms its cache. A fence Pele refuses becomes
 * `diagram_unrendered` lint, kept by the library (`setDiagramRenders`, a DO call outside the write
 * transaction) and shown in `work`, the next `read` and, when the answers come within a short
 * budget, the write's own result. "render unavailable" (no RENDER binding, the service down or
 * slow) is no verdict: no lint, and never a failed write.
 */
import { chartForRender, libraryText } from "./chart-data";
import type { BlobStore, LibraryClient } from "./client";
import type { LintWarning } from "./format/types";
import { RENDER_UNAVAILABLE, type RenderContext, type RenderDiagram } from "./render";
import type { ImportResult, OpResult, RenderJob, RenderVerdict } from "./store/store";

/** How long a write's answer waits for its diagrams' verdicts; later ones land after it. */
export const RENDER_LINT_BUDGET_MS = 300;

export interface RenderLintDeps {
  renderDiagram?: RenderDiagram;
  /** Where a chart's data files are read from (TEMPRA-207). */
  blobs?: BlobStore;
  /** RENDER_LINT_BUDGET_MS unless set (tests). */
  renderBudgetMs?: number;
}

/** A page version's `diagram_unrendered` lint, as the library now holds it. */
export type RenderedLint = { path: string; hash: string; lint: LintWarning[] }[];

/**
 * Renders the jobs and keeps the verdicts. Resolves with the updated lint when everything answered
 * within the budget, else null; the rest goes on through `waitUntil` (or simply runs on, when
 * there is none). Never throws.
 */
export async function lintRenders(
  d: RenderLintDeps,
  lib: Pick<LibraryClient, "setDiagramRenders" | "read">,
  jobs: RenderJob[],
  ctx: RenderContext,
  waitUntil?: (p: Promise<unknown>) => void,
): Promise<RenderedLint | null> {
  const render = d.renderDiagram;
  if (!render || jobs.length === 0) return null;
  const verdict = async (
    g: RenderJob["diagrams"][number],
    path: string,
  ): Promise<RenderVerdict | null> => {
    let source = g.source;
    if (g.lang === "vega-lite") {
      // Its data inline first; data that cannot be read is no verdict on the chart.
      if (!d.blobs) return null;
      const chart = await chartForRender(source, path, libraryText(lib, d.blobs));
      if (!chart.ok) return null;
      source = chart.source;
    }
    const r = await render(
      { source, ...(g.lang ? { lang: g.lang } : {}), theme: "light", png: false },
      ctx,
    );
    if (r.svg) return { key: g.key, error: null };
    if (!r.error || r.error.message.startsWith(RENDER_UNAVAILABLE)) return null;
    const { message, line, column } = r.error;
    return { key: g.key, error: { message, line, column } };
  };
  const work = (async (): Promise<RenderedLint> => {
    const done = await Promise.all(
      jobs.map(async (j) => ({
        page_id: j.page_id,
        hash: j.hash,
        verdicts: (await Promise.all(j.diagrams.map((g) => verdict(g, j.path)))).filter(
          (v): v is RenderVerdict => v !== null,
        ),
      })),
    );
    const known = done.filter((j) => j.verdicts.length > 0);
    return known.length > 0 ? lib.setDiagramRenders(known) : [];
  })().catch((e) => {
    console.error(JSON.stringify({ render_lint_failed: String(e) }));
    return [] as RenderedLint;
  });
  waitUntil?.(work);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), d.renderBudgetMs ?? RENDER_LINT_BUDGET_MS);
  });
  try {
    return await Promise.race([work, late]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

const withUnrendered = (lint: LintWarning[], unrendered: LintWarning[]) => [
  ...lint.filter((l) => l.code !== "diagram_unrendered" && !l.rendered),
  ...unrendered,
];

/** A write's op results with the `diagram_unrendered` lint that came in time. */
export function mergeOpLint(results: OpResult[], rendered: RenderedLint): OpResult[] {
  return results.map((r) => {
    const got = rendered.find((x) => x.path === r.path && x.hash === r.hash);
    return got ? { ...r, lint: withUnrendered(r.lint, got.lint) } : r;
  });
}

/** An import's warnings with the `diagram_unrendered` lint that came in time. */
export function mergeImportLint(
  warnings: ImportResult["warnings"],
  rendered: RenderedLint,
): ImportResult["warnings"] {
  const out = warnings.map((w) => {
    const got = rendered.find((x) => x.path === w.path);
    return got ? { ...w, lint: withUnrendered(w.lint, got.lint) } : w;
  });
  for (const x of rendered) {
    if (x.lint.length > 0 && !out.some((w) => w.path === x.path)) {
      out.push({ path: x.path, lint: x.lint });
    }
  }
  return out.filter((w) => w.lint.length > 0);
}
