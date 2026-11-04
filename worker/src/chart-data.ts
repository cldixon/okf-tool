/**
 * A Vega-Lite fence's data, read from the library for the render Worker (TEMPRA-207): the render
 * Worker reaches no network and no library, so this Worker makes every dataset inline before a
 * chart goes to it (@tempra/editor `inlineChartData`). Free of Worker APIs.
 */
import { CHART_MAX_DATA, ChartDataError, inlineChartData, parseChart } from "@tempra/editor/doc";
import type { BlobStore, LibraryClient } from "./client";
import { readBytes } from "./images";
import type { RenderError } from "./render";

/** A file's text in the library, or null when there is no attachment there (or it is too big). */
export function libraryText(
  lib: Pick<LibraryClient, "read">,
  blobs: BlobStore,
): (path: string) => Promise<string | null> {
  return async (path) => {
    const view = await lib.read(path).catch(() => null);
    if (!view || view.kind !== "attachment" || view.size > CHART_MAX_DATA) return null;
    const obj = await blobs.get(view.hash);
    if (!obj) return null;
    return new TextDecoder().decode(await readBytes(obj.body));
  };
}

/** The chart's source as the render Worker takes it: JSON with its data inline; or what is wrong. */
export async function chartForRender(
  source: string,
  pagePath: string,
  read: (path: string) => Promise<string | null>,
): Promise<{ ok: true; source: string } | { ok: false; error: RenderError }> {
  const parsed = parseChart(source);
  if (!parsed.ok) {
    const { message, line, column } = parsed;
    return { ok: false, error: { message: `The chart ${message}.`, line, column } };
  }
  try {
    return {
      ok: true,
      source: JSON.stringify(await inlineChartData(parsed.spec, pagePath, read)),
    };
  } catch (e) {
    if (!(e instanceof ChartDataError)) throw e;
    return { ok: false, error: { message: `The chart's data: ${e.message}.`, line: 0, column: 0 } };
  }
}
