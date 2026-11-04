import { ApiError } from "../api";
import { enc, type Urls } from "../urls";

/*
 * A concept's tools in the top bar (take 4, TEMPRA-114; tempra-dev: app/reader, Layout): ⋯, with
 * Copy page at its head (TEMPRA-145; on a phone since TEMPRA-118), then History, Properties, View
 * Markdown, Copy link and Download .md. Comment is in the page's actions (PageActions.svelte).
 */

/** The file as stored, frontmatter and body: what an agent reads (`GET …/files/{path}`). */
export async function storedFile(urls: Urls, path: string): Promise<string> {
  const res = await fetch(urls.api(`files/${enc(path)}`, { at: urls.at }), {
    credentials: "same-origin",
    headers: { Accept: "text/markdown" },
  });
  if (!res.ok) throw new ApiError(res.status, "error", res.statusText);
  return res.text();
}
