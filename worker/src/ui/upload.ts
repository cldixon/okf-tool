/**
 * The upload link's page (TEMPRA-196; tempra-dev: app/media, Upload link): a signed-in person
 * chooses the file an agent prepared an upload for, and their browser sends it. A server page
 * like sign-in and consent: no script, the strict headers, one form posting to its own URL.
 */
import { alertNotice, esc, invalid, PAGE_HEADERS, page } from "../oauth/pages";
import { kindOf } from "../uploads";

const ERROR_ID = "upload-error";

/** Why a person is asked to upload a file an agent made (TEMPRA-205); the panel says the same. */
const AGENTS_CANNOT = "Agents can't send files to Tempra themselves yet, so choose it here.";

/** What the page shows about the prepared upload. */
export interface UploadView {
  /** The library as people read it: its title, else its slug. */
  library: string;
  libraryHref: string;
  path: string;
  /** Who prepared it: "Claude for @ann". */
  agent: string;
  description?: string;
  media: string | null;
  /** The agent made the file and handed it to the person in the chat (TEMPRA-205). */
  fromAgent?: boolean;
  /** When the link stops working, in seconds since the epoch. */
  exp: number;
  /** The time now, in seconds since the epoch. */
  now: number;
}

/** A size as people read it: "349 KB". */
export function readableSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const fact = (term: string, value: string) => `<div><dt>${term}</dt><dd>${value}</dd></div>`;

/** The page with its form, and the refusal of the last try when there was one. */
export function uploadPage(v: UploadView, error?: { message: string; status: number }): Response {
  const minutes = Math.max(1, Math.ceil((v.exp - v.now) / 60));
  const facts = [
    fact("Library", `<a href="${esc(v.libraryHref)}">${esc(v.library)}</a>`),
    fact("Saved as", `<code>${esc(v.path)}</code>`),
    v.description ? fact("Shows", esc(v.description)) : "",
    kindOf(v.media) ? fact("Kind", esc(kindOf(v.media) as string)) : "",
  ].join("");
  const accept = v.media ? ` accept="${esc(v.media)}"` : "";
  const body = `<h1>Upload a file</h1>
<p class="public-lead">${
    v.fromAgent
      ? `${esc(v.agent)} made this file and gave it to you in the chat. ${AGENTS_CANNOT}`
      : `${esc(v.agent)} asked for this file.`
  }</p>
<dl class="facts">${facts}</dl>
${error ? alertNotice(ERROR_ID, error.message) : ""}<form method="post" enctype="multipart/form-data" class="stack">
<div class="field"><label>File
<input name="file" type="file" required${accept}${invalid(ERROR_ID, !!error, "file-hint")}></label>
<span class="field-hint" id="file-hint">${v.fromAgent ? "Save it from the chat first, then choose it here." : "If it came from a chat, choose it again here."}</span></div>
<p><button class="primary" type="submit">Upload</button></p></form>
<p class="public-aside">This link works once, for ${minutes} more ${minutes === 1 ? "minute" : "minutes"}.</p>`;
  return new Response(page("Upload a file", body), {
    status: error?.status ?? 200,
    headers: { ...PAGE_HEADERS },
  });
}

/** After the upload: what was stored, and where to see it. */
export function uploadedPage(o: {
  path: string;
  size: number;
  fileHref: string;
  agent: string;
}): Response {
  const body = `<h1>Uploaded</h1>
<p class="public-lead"><code>${esc(o.path)}</code> (${esc(readableSize(o.size))}) is in the library. ${esc(o.agent)} can place it now; you can go back to the chat.</p>
<p class="public-actions"><a class="button primary" href="${esc(o.fileHref)}">Open the file</a></p>`;
  return new Response(page("Uploaded", body), { headers: { ...PAGE_HEADERS } });
}
