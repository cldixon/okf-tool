/**
 * Getting a file's bytes in (TEMPRA-158, TEMPRA-204; tempra-dev decisions/agents-never-type-file-bytes):
 * a caller asks for an upload URL (MCP `prepare_upload`, REST `POST …/uploads`), and a shell
 * PUTs the file to it or a person sends it from their browser. Nothing is declared about the
 * bytes: whatever arrives is the file, and a transfer cut short is caught by its length.
 * Free of Worker APIs.
 */
import type { TokenInfo } from "./auth";
import { type LibraryClient, WORKER_ATTACHMENT_CAP } from "./client";
import { StoreError } from "./store/errors";
import type { RequestContext } from "./store/store";

/**
 * How long an upload URL and its page stay good: long enough for a person to switch from a chat
 * to their files and back (TEMPRA-196).
 */
export const UPLOAD_TTL_SECONDS = 60 * 60;

/** What an upload URL's token carries: the write to apply when the bytes arrive, and as whom. */
export interface UploadGrant {
  k: "upload";
  /** Null for a blob-first upload (REST): the PUT stores the bytes and answers with their hash. */
  path: string | null;
  media: string | null;
  /** Who has the file: the person, or the agent that made it and handed it over (TEMPRA-205). */
  origin?: UploadOrigin;
  if_match?: string;
  /** What the file shows, kept with the attach op (TEMPRA-157, for the file's page). */
  description?: string;
  /** Who made it and its licence (TEMPRA-170). */
  credit?: string;
  licence?: string;
  note: string | null;
  actor: string;
  by: RequestContext["by"];
  /** The caller as it was when it asked; checked again when the bytes arrive. */
  token: TokenInfo;
}

/**
 * Who has the file to upload (TEMPRA-205): the person (a photo they attached in the chat), or the
 * agent, which made it where it cannot reach Tempra and has handed it to the person to send.
 */
export type UploadOrigin = "person" | "agent";

export const UPLOAD_ORIGINS = ["person", "agent"] as const;

/** An origin as given, or a refusal; none is the person's. */
export function checkOrigin(v: unknown): UploadOrigin {
  if (v === undefined || v === null || v === "") return "person";
  if (v === "person" || v === "agent") return v;
  throw new StoreError(400, "bad_origin", "`origin` is `person` or `agent`.");
}

/**
 * The bytes received against the request's `Content-Length` (TEMPRA-204): a transfer cut short
 * is refused rather than stored. No header (a chunked send) means nothing to compare.
 */
export function checkLength(bytes: Uint8Array, header: string | undefined): void {
  if (header === undefined || header.trim() === "") return;
  const want = Number(header);
  if (!Number.isInteger(want) || want < 0 || want === bytes.length) return;
  throw new StoreError(
    400,
    "incomplete_upload",
    `The upload was cut short: the request said ${want} bytes and ${bytes.length} arrived. Nothing was written; send the file again.`,
    { expected: want, received: bytes.length },
  );
}

const KIND: Record<string, string> = {
  "image/png": "PNG image",
  "image/jpeg": "JPEG image",
  "image/gif": "GIF image",
  "image/webp": "WebP image",
  "image/avif": "AVIF image",
  "image/svg+xml": "SVG image",
  "video/mp4": "MP4 video",
  "video/webm": "WebM video",
  "audio/mpeg": "MP3 audio",
  "audio/ogg": "Ogg audio",
  "audio/wav": "WAV audio",
  "application/pdf": "PDF",
};

/** "a PNG image", "an MP4 video": the kinds above that are said with a vowel sound take "an". */
export function withArticle(kind: string): string {
  return `${/^(AVIF|SVG|MP[34]|Ogg|[aeiou])/i.test(kind) ? "an" : "a"} ${kind}`;
}

/** The kind of file an upload expects, as people say it: "PNG image"; the type itself otherwise. */
export function kindOf(media: string | null | undefined): string | null {
  if (!media) return null;
  const m = media.split(";")[0]?.trim().toLowerCase() ?? "";
  return KIND[m] ?? (m === "application/octet-stream" ? null : m);
}

/** A request body read whole, refused once it passes `cap` (no Content-Length is trusted). */
export async function readCapped(
  body: ReadableStream<Uint8Array> | null,
  cap = WORKER_ATTACHMENT_CAP,
): Promise<Uint8Array> {
  if (!body) return new Uint8Array(0);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > cap) {
      await reader.cancel().catch(() => {});
      throw new StoreError(413, "attachment_too_large", `Attachments are capped at ${cap} bytes.`);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

/**
 * The URL to PUT a file to, a curl line that does it, and for a file at a path, the page a
 * signed-in person opens to send it from their browser instead (TEMPRA-196); one token for all.
 */
export async function prepareUpload(
  lib: LibraryClient,
  origin: string,
  grant: Omit<UploadGrant, "k">,
): Promise<{ url: string; method: "PUT"; expires: string; curl: string; upload_page?: string }> {
  const token = await lib.signUpload({ k: "upload", ...grant }, UPLOAD_TTL_SECONDS);
  const { do_id, owner, slug } = grant.token.library;
  const url = `${origin}/ul/${encodeURIComponent(do_id)}/${token}`;
  const file = grant.path?.split("/").pop() || "<file>";
  return {
    url,
    method: "PUT",
    expires: new Date(Date.now() + UPLOAD_TTL_SECONDS * 1000).toISOString(),
    curl: `curl -sS -T ${shellQuote(file)} '${url}'`,
    // Grants from before A1 carry no owner handle, so no page address.
    ...(grant.path && owner
      ? {
          upload_page: `${origin}/${encodeURIComponent(owner)}/${encodeURIComponent(slug)}/-/upload/${token}`,
        }
      : {}),
  };
}

/** A filename for the curl line, quoted when the shell would split or expand it. */
function shellQuote(s: string): string {
  return /^[A-Za-z0-9._@%+=:,/-]+$/.test(s) ? s : `'${s.replace(/'/g, "'\\''")}'`;
}

/** The type the PUT says, when it says one, must be the type declared at prepare. */
export function checkMedia(declared: string | null, header: string | undefined): void {
  const sent = header?.split(";")[0]?.trim().toLowerCase();
  if (!sent || sent === "application/octet-stream" || declared === null) return;
  if (sent !== declared.toLowerCase()) {
    throw new StoreError(
      400,
      "media_mismatch",
      `This upload was prepared for ${declared}, but the request says ${sent}. Prepare it again with the right media, or send no Content-Type.`,
    );
  }
}
