import type { BlobStore } from "./client";
import { imageInfo } from "./media";

/**
 * Attachment images scaled through Cloudflare Images (the `IMAGES` binding; TEMPRA-153, and the
 * reader's variants, TEMPRA-162). A scaled copy is cached in R2 at
 * `variants/<hash>/<edge>.<ext>`, outside `blobs/`, so the blob sweep never counts it as a blob;
 * the sweep deletes a blob's variants with it (variantKeysFor). Free of Worker APIs: the binding
 * and the cache come in as interfaces, so tests run under bun with a double.
 */

/** Formats a variant can take. */
export type VariantFormat = "webp" | "avif" | "jpeg" | "png";

type VariantMedia = "image/webp" | "image/avif" | "image/jpeg" | "image/png";

const MEDIA: Record<VariantFormat, VariantMedia> = {
  webp: "image/webp",
  avif: "image/avif",
  jpeg: "image/jpeg",
  png: "image/png",
};

/** Output quality per format; part of what a cached variant is, so changing it needs new keys. */
const QUALITY: Record<VariantFormat, number | undefined> = {
  webp: 80,
  avif: 60,
  jpeg: 80,
  png: undefined,
};

/**
 * The long edges a variant may have. A fixed set keeps the cache bounded and lets the sweep
 * delete every variant of a blob without listing the bucket; add an edge here to offer it.
 */
export const VARIANT_EDGES = [320, 640, 768, 1092, 1280, 1568, 1920] as const;
export const VARIANT_FORMATS = Object.keys(MEDIA) as VariantFormat[];

/** Raster media models take as image content (and Images decodes). */
export const RASTER_MEDIA = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

/** The long edge a model gets an image at: Claude's own downscale point. */
export const MODEL_EDGE = 1568;
/** At most this many bytes of image for a model; smaller edges are tried until it fits. */
export const MODEL_BYTES = 400 * 1024;
const MODEL_LADDER = [MODEL_EDGE, 1092, 768] as const;
/**
 * At most this many image blocks in one call, and this many bytes of image in them all (`read` of
 * a page with `images` or `figures`, TEMPRA-154); first guesses for the media trial
 * (tempra-dev: app/media, Limits).
 */
export const IMAGES_PER_CALL = 6;
export const IMAGE_BYTES_PER_CALL = 2 * 1024 * 1024;

export const variantKey = (hash: string, edge: number, format: VariantFormat) =>
  `variants/${hash}/${edge}.${format}`;

/** Every variant key a blob can have, for the given `blobs/<hash>` keys. */
export function variantKeysFor(blobKeys: string[]): string[] {
  const out: string[] = [];
  for (const k of blobKeys) {
    if (!k.startsWith("blobs/")) continue;
    const hash = k.slice("blobs/".length);
    for (const e of VARIANT_EDGES)
      for (const f of VARIANT_FORMATS) out.push(variantKey(hash, e, f));
  }
  return out;
}

/**
 * What one transform asks of Images: a box to fit within (never enlarged with `scale-down`), or
 * a crop (`trim`, in pixels of the original), or nothing but a new format.
 */
export interface ImageTransform {
  width?: number;
  height?: number;
  fit?: "scale-down" | "cover";
  trim?: { top: number; left: number; width: number; height: number };
}

/** The part of Cloudflare's ImagesBinding used here; tests pass a double. */
export interface ImageTransformerLike {
  input(stream: ReadableStream<Uint8Array>): {
    transform(t: ImageTransform): {
      output(o: {
        format: VariantMedia;
        quality?: number;
      }): Promise<{ image(): ReadableStream<Uint8Array>; contentType(): string }>;
    };
  };
}

/** Where scaled copies are kept (R2 in production). */
export interface VariantCache {
  get(key: string): Promise<{ bytes: Uint8Array; media: string } | null>;
  put(key: string, bytes: Uint8Array, media: string): Promise<void>;
}

export interface ScaledImage {
  bytes: Uint8Array;
  media: string;
}

export type ModelImage =
  | (ScaledImage & { scaled: boolean })
  | { tooLarge: true; size: number }
  | { missing: true };

export interface Images {
  /**
   * The blob's image with its long edge at most `maxEdge` (never enlarged), in `format`; cached,
   * so a second call costs one R2 read. Null when it cannot be scaled: no binding, the blob is
   * gone, or Images refused it (not an image, the product not enabled).
   */
  scaled(
    hash: string,
    opts: { maxEdge: number; format: VariantFormat },
  ): Promise<ScaledImage | null>;
  /**
   * The image as a model should get it: scaled to MODEL_EDGE within MODEL_BYTES; without the
   * binding, the original when it is within MODEL_BYTES, else `tooLarge`.
   */
  forModel(blob: { hash: string; size: number; media: string | null }): Promise<ModelImage>;
  /**
   * Bytes that are not a stored blob (a drawn diagram's PNG, TEMPRA-166) as a model should get
   * them: as they are when the long edge is within MODEL_EDGE and the bytes within MODEL_BYTES,
   * else scaled down the same ladder as `forModel` (not cached: the render Worker caches the
   * PNG); without the binding, as they are when within MODEL_BYTES, else `tooLarge`.
   */
  fitForModel(bytes: Uint8Array, media: string): Promise<ModelImage>;
  /**
   * Bytes transformed for a new attachment (TEMPRA-208, MCP `transform`), not cached: what was
   * asked, in `format`. Null with no binding; throws Images' own error.
   */
  transform(
    bytes: Uint8Array,
    t: ImageTransform,
    format: VariantFormat,
  ): Promise<ScaledImage | null>;
}

export function imagesService(d: {
  blobs: BlobStore;
  transformer?: ImageTransformerLike | null;
  cache?: VariantCache | null;
}): Images {
  const scaled: Images["scaled"] = async (hash, { maxEdge, format }) => {
    if (!(VARIANT_EDGES as readonly number[]).includes(maxEdge)) {
      throw new Error(`Not a variant edge: ${maxEdge}`);
    }
    if (!d.transformer) return null;
    const key = variantKey(hash, maxEdge, format);
    const hit = await d.cache?.get(key).catch(() => null);
    if (hit) return hit;
    const obj = await d.blobs.get(hash);
    if (!obj) return null;
    try {
      const out = await d.transformer
        .input(toStream(obj.body))
        .transform({ width: maxEdge, height: maxEdge, fit: "scale-down" })
        .output({ format: MEDIA[format], quality: QUALITY[format] });
      const bytes = await readBytes(out.image());
      const media = out.contentType() || MEDIA[format];
      await d.cache?.put(key, bytes, media).catch((e) => console.error("variant cache put", e));
      return { bytes, media };
    } catch (e) {
      console.error(JSON.stringify({ image_transform_failed: String(e), hash, maxEdge, format }));
      return null;
    }
  };

  /** One scale of bytes held in memory; null when Images refuses or is not bound. */
  const scaleBytes = async (bytes: Uint8Array, edge: number): Promise<ScaledImage | null> => {
    if (!d.transformer) return null;
    try {
      const out = await d.transformer
        .input(toStream(bytes))
        .transform({ width: edge, height: edge, fit: "scale-down" })
        .output({ format: MEDIA.webp, quality: QUALITY.webp });
      return { bytes: await readBytes(out.image()), media: out.contentType() || MEDIA.webp };
    } catch (e) {
      console.error(JSON.stringify({ image_transform_failed: String(e), edge }));
      return null;
    }
  };

  return {
    scaled,
    async transform(bytes, t, format) {
      if (!d.transformer) return null;
      const out = await d.transformer
        .input(toStream(bytes))
        .transform(t)
        .output({ format: MEDIA[format], quality: QUALITY[format] });
      return { bytes: await readBytes(out.image()), media: out.contentType() || MEDIA[format] };
    },
    async fitForModel(bytes, media) {
      const info = imageInfo(bytes);
      const edge = info?.ok ? Math.max(info.width, info.height) : Number.POSITIVE_INFINITY;
      if (edge <= MODEL_EDGE && bytes.byteLength <= MODEL_BYTES) {
        return { bytes, media, scaled: false };
      }
      let last: ScaledImage | null = null;
      for (const e of MODEL_LADDER) {
        const s = await scaleBytes(bytes, e);
        if (!s) break;
        last = s;
        if (s.bytes.byteLength <= MODEL_BYTES) return { ...s, scaled: true };
      }
      if (last) return { ...last, scaled: true };
      if (bytes.byteLength > MODEL_BYTES) return { tooLarge: true, size: bytes.byteLength };
      return { bytes, media, scaled: false };
    },
    async forModel(blob) {
      let last: ScaledImage | null = null;
      for (const edge of MODEL_LADDER) {
        const s = await scaled(blob.hash, { maxEdge: edge, format: "webp" });
        if (!s) break;
        last = s;
        if (s.bytes.byteLength <= MODEL_BYTES) return { ...s, scaled: true };
      }
      if (last) return { ...last, scaled: true };
      if (blob.size > MODEL_BYTES) return { tooLarge: true, size: blob.size };
      const obj = await d.blobs.get(blob.hash);
      if (!obj) return { missing: true };
      return {
        bytes: await readBytes(obj.body),
        media: blob.media ?? "application/octet-stream",
        scaled: false,
      };
    },
  };
}

/** Scaled copies in the blobs bucket, beside (not under) `blobs/`. */
export function r2VariantCache(bucket: R2Bucket): VariantCache {
  return {
    async get(key) {
      const obj = await bucket.get(key);
      if (!obj) return null;
      return {
        bytes: new Uint8Array(await obj.arrayBuffer()),
        media: obj.httpMetadata?.contentType ?? "application/octet-stream",
      };
    },
    async put(key, bytes, media) {
      await bucket.put(key, bytes, { httpMetadata: { contentType: media } });
    },
  };
}

/** Deletes the variants of the blobs at these keys, a thousand keys a call (R2's limit). */
export async function deleteVariants(
  bucket: { delete(keys: string[]): Promise<void> },
  blobKeys: string[],
): Promise<void> {
  const keys = variantKeysFor(blobKeys);
  for (let i = 0; i < keys.length; i += 1000) await bucket.delete(keys.slice(i, i + 1000));
}

export async function readBytes(body: ReadableStream | Uint8Array): Promise<Uint8Array> {
  if (body instanceof Uint8Array) return body;
  return new Uint8Array(await new Response(body).arrayBuffer());
}

function toStream(body: ReadableStream | Uint8Array): ReadableStream<Uint8Array> {
  if (!(body instanceof Uint8Array)) return body as ReadableStream<Uint8Array>;
  return new ReadableStream({
    start(c) {
      c.enqueue(body);
      c.close();
    },
  });
}

/** Base64 without spreading megabytes onto the stack. */
export function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}
