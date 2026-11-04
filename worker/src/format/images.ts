/**
 * Figure lint (tempra-dev: app/media, Lint and refusals; TEMPRA-159): what makes an image in a body
 * poor for people or useless to a screen reader. Lint only, never a refusal. Two kinds:
 *
 * - from the body alone ({@link imageLint}): an image with no alt text (`image_no_alt`) and one
 *   hotlinked from another site (`image_external`), checked with the page's other field lint;
 * - from what an image points to ({@link imageTargetLint}): an attachment too large to be a figure
 *   (`image_large`) or one that is not an image, video, audio or PDF (`image_not_image`). The store
 *   recomputes these when the target changes, as it does broken links.
 */
import { type Doc, walk } from "@tempra/editor/doc";
import { targets } from "./markdown";
import type { LintWarning, StoredLink } from "./types";

/** An image used as a figure over this many bytes is `image_large`. */
export const IMAGE_MAX_BYTES = 2 * 1024 * 1024;
/** An image used as a figure over this many pixels on its long edge is `image_large`. */
export const IMAGE_MAX_EDGE = 4000;

/** The lint codes that depend on an image's target, recomputed when the target changes. */
export const IMAGE_TARGET_CODES: ReadonlySet<string> = new Set(["image_large", "image_not_image"]);

/** What the store knows about an attachment an image points to. */
export interface ImageTarget {
  size: number;
  media: string | null;
  width: number | null;
  height: number | null;
}

/** An image in a body: its target as written and its alt text. */
interface BodyImage {
  url: string;
  alt: string;
}

/** Every image in a body, `![alt](url)` and `![alt][ref]` (through its definition), in order. */
function images(doc: Doc): BodyImage[] {
  const defs = new Map<string, string>();
  walk(doc, (n) => {
    if (n.type === "definition") defs.set(n.identifier.toLowerCase(), n.url);
    return undefined;
  });
  const out: BodyImage[] = [];
  walk(doc, (n) => {
    if (n.type === "image") out.push({ url: n.url, alt: n.alt ?? "" });
    if (n.type === "imageReference") {
      const url = defs.get(n.identifier.toLowerCase());
      if (url !== undefined) out.push({ url, alt: n.alt ?? "" });
    }
    return undefined;
  });
  return out;
}

/** An http(s) URL, or a scheme-relative one, which reaches another site. */
function hotlinkHost(url: string): string | null {
  if (!/^(https?:)?\/\//i.test(url)) return null;
  try {
    return new URL(url, "https://x.invalid").host || null;
  } catch {
    return null;
  }
}

/** Lint from a body's images alone: missing alt text and hotlinks. */
export function imageLint(doc: Doc): LintWarning[] {
  const out: LintWarning[] = [];
  for (const img of images(doc)) {
    if (img.alt.trim() === "") {
      out.push({
        code: "image_no_alt",
        message: `Image ${img.url} has no alt text; say what it shows inside the brackets, ![what it shows](${img.url}). Alt text is what a screen reader says and what an agent reads when it does not ask for the image.`,
        target: img.url,
      });
    }
    const host = hotlinkHost(img.url);
    if (host) {
      out.push({
        code: "image_external",
        message: `Image ${img.url} is hotlinked from ${host}; bring it into the library with \`attach\` and \`source_url: "${img.url}"\` (the server fetches it and records where from; put it beside this page), point the image at the attached path, and cite the original in \`sources\`.`,
        target: img.url,
      });
    }
  }
  return out;
}

/** The stored links of a record that are images (`![…](x)`, or a definition an image uses). */
export function imageLinks(doc: Doc, links: StoredLink[]): StoredLink[] {
  const all = targets(doc);
  const refs = new Set<string>();
  walk(doc, (n) => {
    if (n.type === "imageReference") refs.add(n.identifier.toLowerCase());
    return undefined;
  });
  return links.filter((l) => {
    const n = all[l.at];
    if (!n) return false;
    if (n.type === "image") return true;
    return n.type === "definition" && refs.has(n.identifier.toLowerCase());
  });
}

/** Whether a media type is drawn as a figure: an image, video, audio or a PDF. */
export function isFigureMedia(media: string): boolean {
  const m = media.toLowerCase();
  return /^(image|video|audio)\//.test(m) || m === "application/pdf";
}

function megabytes(n: number): string {
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Lint from what each image points to: `attachment` returns the attachment at a link's target, or
 * null where the target is a page or missing (broken links are linted elsewhere).
 */
export function imageTargetLint(
  links: StoredLink[],
  attachment: (link: StoredLink) => ImageTarget | null,
): LintWarning[] {
  const out: LintWarning[] = [];
  const seen = new Set<string>();
  for (const l of links) {
    if (seen.has(l.path)) continue;
    seen.add(l.path);
    const a = attachment(l);
    if (!a) continue;
    if (a.media && !isFigureMedia(a.media)) {
      out.push({
        code: "image_not_image",
        message: `![…](${l.raw}) points to /${l.path}, a ${a.media} file, which is not an image, video, audio or PDF and cannot be drawn as a figure; link it as [name](${l.raw}) instead, or attach the image you meant and point to that.`,
        target: l.path,
      });
      continue;
    }
    // Video, audio and PDFs are not images: their size is theirs (TEMPRA-164).
    if (a.media && !a.media.toLowerCase().startsWith("image/")) continue;
    const edge = Math.max(a.width ?? 0, a.height ?? 0);
    if (a.size > IMAGE_MAX_BYTES || edge > IMAGE_MAX_EDGE) {
      const dims = a.width && a.height ? `, ${a.width} × ${a.height} px` : "";
      out.push({
        code: "image_large",
        message: `Image /${l.path} is ${megabytes(a.size)}${dims}, over the ${megabytes(IMAGE_MAX_BYTES)} or ${IMAGE_MAX_EDGE} px (long edge) a figure should be; make a smaller one with \`transform\` (op \`resize\`, an \`edge\` of 1920 or less) and point the image at it if you put it elsewhere.`,
        target: l.path,
      });
    }
  }
  return out;
}
