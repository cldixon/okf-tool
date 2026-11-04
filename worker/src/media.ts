import { StoreError } from "./store/errors";

/**
 * What attachment bytes are (TEMPRA-152): the image formats the app draws, checked from their
 * bytes alone (signature, header, the container's lengths through its end), DOM-free and with no
 * WASM, so a write can refuse a broken image before the synchronous write transaction. The type
 * of an image comes from its bytes, never from a header or an extension, and its width and
 * height from its header. Free of Worker APIs.
 */

export type ImageFormat = "png" | "jpeg" | "gif" | "webp" | "avif" | "svg";

export const IMAGE_MEDIA: Record<ImageFormat, string> = {
  png: "image/png",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  svg: "image/svg+xml",
};

const FORMAT_NAME: Record<ImageFormat, string> = {
  png: "PNG",
  jpeg: "JPEG",
  gif: "GIF",
  webp: "WebP",
  avif: "AVIF",
  svg: "SVG",
};

/** A recognised image: its format and size in pixels, or what is wrong with it. */
export type ImageInfo =
  | { ok: true; format: ImageFormat; width: number; height: number }
  | { ok: false; format: ImageFormat; problem: string };

/** What a checked attachment is stored as. */
export interface AttachmentInfo {
  media: string | null;
  width?: number;
  height?: number;
  /** Set when the declared type was ignored for the one the bytes have. */
  note?: string;
}

class Broken extends Error {}
const broken = (problem: string): never => {
  throw new Broken(problem);
};

const ascii = (b: Uint8Array, at: number, n: number) =>
  at + n > b.length ? "" : String.fromCharCode(...b.subarray(at, at + n));

const startsWith = (b: Uint8Array, sig: number[]) =>
  b.length >= sig.length && sig.every((x, i) => b[i] === x);

/** The format the bytes announce by their signature, before any further check. */
export function sniffImage(b: Uint8Array): ImageFormat | null {
  if (startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "png";
  if (startsWith(b, [0xff, 0xd8, 0xff])) return "jpeg";
  if (ascii(b, 0, 6) === "GIF87a" || ascii(b, 0, 6) === "GIF89a") return "gif";
  if (ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 4) === "WEBP") return "webp";
  if (ascii(b, 4, 4) === "ftyp" && avifBrand(b)) return "avif";
  const root = svgRoot(b);
  if (root !== null && attr(root, "xmlns") === SVG_NS) return "svg";
  return null;
}

/**
 * The other media the design draws (tempra-dev app/media.md, Kinds: video, audio, PDF), by their
 * signature alone; null for anything else. Used where the type must come from the bytes and
 * nothing else is accepted (a fetched `source_url`, TEMPRA-157). Images are `sniffImage`'s.
 */
export function sniffMedia(b: Uint8Array): string | null {
  if (ascii(b, 0, 5) === "%PDF-") return "application/pdf";
  if (ascii(b, 0, 4) === "OggS") return "audio/ogg";
  if (ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 4) === "WAVE") return "audio/wav";
  if (ascii(b, 0, 3) === "ID3") return "audio/mpeg";
  // An MPEG audio frame: 11 sync bits, MPEG 1, 2 or 2.5, layer III.
  if (b.length >= 2 && b[0] === 0xff && ((b[1] as number) & 0xe6) === 0xe2) return "audio/mpeg";
  if (
    startsWith(b, [0x1a, 0x45, 0xdf, 0xa3]) &&
    ascii(b, 0, Math.min(64, b.length)).includes("webm")
  )
    return "video/webm";
  if (ascii(b, 4, 4) === "ftyp" && !avifBrand(b)) return "video/mp4";
  return null;
}

/**
 * Checks bytes as an image: the format their signature names, or `expect` (the declared one) when
 * they have none, in which case they are not that image. Null when neither names an image format.
 */
export function imageInfo(b: Uint8Array, expect?: ImageFormat | null): ImageInfo | null {
  const format = sniffImage(b) ?? expect ?? null;
  if (!format) return null;
  try {
    if (!sniffImage(b) && format !== "svg") {
      broken(`it does not start with a ${FORMAT_NAME[format]} signature`);
    }
    const { width, height } = CHECKS[format](b);
    // An SVG need not say its size; every other format does.
    if (format !== "svg" && !(width > 0 && height > 0))
      broken("its header gives no width and height");
    return { ok: true, format, width, height };
  } catch (e) {
    if (e instanceof Broken) return { ok: false, format, problem: e.message };
    if (e instanceof RangeError) return { ok: false, format, problem: "it ends early" };
    throw e;
  }
}

/** The image format a media type names, if it is one this module checks. */
export function formatOf(media: string | null | undefined): ImageFormat | null {
  const m = media?.split(";")[0]?.trim().toLowerCase();
  if (m === "image/jpg" || m === "image/pjpeg") return "jpeg";
  for (const [f, t] of Object.entries(IMAGE_MEDIA)) if (t === m) return f as ImageFormat;
  return null;
}

/**
 * The one check every way an attachment comes in goes through (MCP `attach`, REST `PUT`,
 * import, uploads; `putBlob` in client.ts calls it): an image is refused when broken (400
 * `bad_image`, naming what is wrong) and otherwise stored with the type its bytes have and its
 * width and height; other bytes keep the declared type.
 */
export function checkAttachment(
  bytes: Uint8Array,
  declared: string | null,
  path?: string,
): AttachmentInfo {
  // Bytes that are a video, audio or a PDF are that, whatever was declared (TEMPRA-164); but
  // HEIC, a cut AVIF and other ISO-BMFF images share MP4's `ftyp`, so one declared as an image
  // is checked as that.
  const sniffed = sniffImage(bytes) ? null : sniffMedia(bytes);
  if (sniffed && !(sniffed === "video/mp4" && declared?.toLowerCase().startsWith("image/"))) {
    return mediaAttachment(bytes, declared);
  }
  const info = imageInfo(bytes, formatOf(declared));
  if (!info) return { media: declared };
  const what = path ? `${path} is not a valid ${FORMAT_NAME[info.format]}` : "Not a valid image";
  if (!info.ok) {
    throw new StoreError(400, "bad_image", `${what}: ${info.problem}.`, {
      format: info.format,
      problem: info.problem,
    });
  }
  const media = IMAGE_MEDIA[info.format];
  const out: AttachmentInfo = { media };
  if (info.width > 0 && info.height > 0) {
    out.width = info.width;
    out.height = info.height;
  }
  if (declared && formatOf(declared) !== info.format) {
    out.note = `The bytes are a ${FORMAT_NAME[info.format]} image, so it is stored as ${media}; the declared ${declared} was ignored.`;
  }
  return out;
}

const MEDIA_NAME: Record<string, string> = {
  "application/pdf": "PDF",
  "audio/ogg": "Ogg",
  "audio/wav": "WAV",
  "audio/mpeg": "MP3",
  "video/webm": "WebM",
  "video/mp4": "MP4",
};

/**
 * Bytes that are not an image (TEMPRA-164): a video, audio or PDF is stored with the type its
 * signature names (`sniffMedia`), the declared one ignored with a note when it disagrees; one
 * declared as audio in the same container keeps it (an `.m4a` is `ftyp`, a WebM may be sound
 * alone). Anything else keeps the declared type.
 */
function mediaAttachment(bytes: Uint8Array, declared: string | null): AttachmentInfo {
  const sniffed = sniffMedia(bytes);
  if (!sniffed) return { media: declared };
  const out = typed(sniffed, declared);
  if (out.media?.startsWith("video/")) {
    const size = videoSize(bytes, out.media);
    if (size) {
      out.width = size.width;
      out.height = size.height;
    }
  }
  return out;
}

function typed(sniffed: string, declared: string | null): AttachmentInfo {
  const said = declared?.split(";")[0]?.trim().toLowerCase() ?? null;
  if (said === sniffed) return { media: sniffed };
  const sub = (m: string) => m.split("/")[1];
  if (said?.startsWith("audio/") && sniffed.startsWith("video/") && sub(said) === sub(sniffed)) {
    return { media: said };
  }
  if (said === "audio/x-m4a" && sniffed === "video/mp4") return { media: "audio/mp4" };
  if (said === "audio/wave" || said === "audio/x-wav" || said === "audio/vnd.wave") {
    if (sniffed === "audio/wav") return { media: sniffed };
  }
  if (!said || said === "application/octet-stream") return { media: sniffed };
  return {
    media: sniffed,
    note: `The bytes are a ${MEDIA_NAME[sniffed] ?? sniffed} file, so it is stored as ${sniffed}; the declared ${declared} was ignored.`,
  };
}

/**
 * A video's frame size from its header, when cheap to find (TEMPRA-164): an MP4's track header
 * (`moov > trak > tkhd`, the largest track) or a WebM's `Tracks > TrackEntry > Video` pixel size.
 * Null when it does not say or does not parse; the browser finds it once the video loads.
 */
export function videoSize(b: Uint8Array, media: string): { width: number; height: number } | null {
  try {
    const size = media === "video/webm" ? webmSize(b) : media === "video/mp4" ? mp4Size(b) : null;
    return size && size.width > 0 && size.height > 0 ? size : null;
  } catch (e) {
    if (e instanceof Broken || e instanceof RangeError) return null;
    throw e;
  }
}

/** How much of a video's start is read for its frame size when it was stored without one (TEMPRA-183). */
export const VIDEO_HEAD_BYTES = 64 * 1024;
/** An MP4 whose `moov` box is larger than this is left unsized rather than read. */
const MOOV_MAX_BYTES = 4 * 1024 * 1024;
/** At most this many top-level MP4 boxes are stepped over looking for `moov`. */
const TOP_BOXES_MAX = 64;

/**
 * A stored video's frame size, as `videoSize` finds it, read in ranges rather than whole (a video
 * from before TEMPRA-164; TEMPRA-183): the first VIDEO_HEAD_BYTES, which hold a WebM's Tracks;
 * for an MP4, its top-level boxes stepped over by their headers until `moov`, which is read alone
 * (it often comes after the media data). `read` gives `length` bytes from `offset` of a blob
 * `size` bytes long. Null when it does not say or does not parse.
 */
export async function videoSizeInRanges(
  read: (offset: number, length: number) => Promise<Uint8Array | null>,
  size: number,
  media: string,
): Promise<{ width: number; height: number } | null> {
  if (media !== "video/mp4" && media !== "video/webm") return null;
  const head = await read(0, Math.min(size, VIDEO_HEAD_BYTES));
  if (!head) return null;
  if (media === "video/webm") return videoSize(head, media);
  const slice = async (at: number, n: number) =>
    at + n <= head.length ? head.subarray(at, at + n) : read(at, n);
  let at = 0;
  for (let i = 0; i < TOP_BOXES_MAX && at + 8 <= size; i++) {
    const h = await slice(at, Math.min(16, size - at));
    if (!h || h.length < 8) return null;
    const v = new DataView(h.buffer, h.byteOffset, h.byteLength);
    let box = v.getUint32(0);
    const type = ascii(h, 4, 4);
    let header = 8;
    if (box === 1) {
      if (h.length < 16) return null;
      box = Number(v.getBigUint64(8));
      header = 16;
    } else if (box === 0) box = size - at;
    if (box < header || at + box > size) return null;
    if (type === "moov") {
      if (box > MOOV_MAX_BYTES) return null;
      const moov = await slice(at, box);
      return moov && moov.length === box ? videoSize(moov, media) : null;
    }
    at += box;
  }
  return null;
}

function mp4Size(b: Uint8Array): { width: number; height: number } | null {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const moov = boxes(b, 0, b.length).find((x) => x[0] === "moov");
  if (!moov) return null;
  let best: { width: number; height: number } | null = null;
  for (const [t, s, e] of boxes(b, moov[1], moov[2])) {
    if (t !== "trak") continue;
    const tkhd = boxes(b, s, e).find((x) => x[0] === "tkhd");
    if (!tkhd || tkhd[2] - tkhd[1] < 84) continue;
    // The payload ends with width and height, 16.16 fixed point.
    const width = Math.round(v.getUint32(tkhd[2] - 8) / 65536);
    const height = Math.round(v.getUint32(tkhd[2] - 4) / 65536);
    if (width * height > (best ? best.width * best.height : 0)) best = { width, height };
  }
  return best;
}

/** An EBML variable-length integer at `at`: its value (marker kept for IDs) and length. */
function vint(b: Uint8Array, at: number, keepMarker: boolean): { value: number; len: number } {
  const first = b[at];
  if (first === undefined || first === 0) broken("an EBML number runs past the end");
  let len = 1;
  while (len <= 8 && !((first as number) & (0x80 >> (len - 1)))) len++;
  if (at + len > b.length) broken("an EBML number runs past the end");
  let value = keepMarker ? (first as number) : (first as number) & (0xff >> len);
  let ones = value === 0xff >> len;
  for (let i = 1; i < len; i++) {
    const x = b[at + i] as number;
    if (x !== 0xff) ones = false;
    value = value * 256 + x;
  }
  // All ones is an unknown size: it runs to the end of its parent.
  return { value: !keepMarker && ones ? -1 : value, len };
}

function webmSize(b: Uint8Array): { width: number; height: number } | null {
  const SEGMENT = 0x18538067;
  const TRACKS = 0x1654ae6b;
  const CLUSTER = 0x1f43b675;
  const elements = function* (from: number, to: number) {
    let at = from;
    while (at < to) {
      const id = vint(b, at, true);
      const size = vint(b, at + id.len, false);
      const data = at + id.len + size.len;
      const end = size.value < 0 ? to : Math.min(to, data + size.value);
      yield { id: id.value, data, end };
      at = end;
    }
  };
  const uint = (s: number, e: number) => {
    let n = 0;
    for (let i = s; i < e; i++) n = n * 256 + (b[i] as number);
    return n;
  };
  for (const top of elements(0, b.length)) {
    if (top.id !== SEGMENT) continue;
    for (const el of elements(top.data, top.end)) {
      if (el.id === CLUSTER) return null;
      if (el.id !== TRACKS) continue;
      for (const entry of elements(el.data, el.end)) {
        if (entry.id !== 0xae) continue;
        for (const video of elements(entry.data, entry.end)) {
          if (video.id !== 0xe0) continue;
          let width = 0;
          let height = 0;
          for (const f of elements(video.data, video.end)) {
            if (f.id === 0xb0) width = uint(f.data, f.end);
            if (f.id === 0xba) height = uint(f.data, f.end);
          }
          if (width > 0 && height > 0) return { width, height };
        }
      }
      return null;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------------------- PNG

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(b: Uint8Array, from: number, to: number): number {
  let c = 0xffffffff;
  for (let i = from; i < to; i++)
    c = (CRC_TABLE[(c ^ (b[i] as number)) & 0xff] as number) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function png(b: Uint8Array) {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let at = 8;
  let width = 0;
  let height = 0;
  let idat = false;
  for (let n = 0; ; n++) {
    if (at + 12 > b.length) broken(`it ends at byte ${b.length} before IEND`);
    const len = v.getUint32(at);
    const type = ascii(b, at + 4, 4);
    if (!/^[A-Za-z]{4}$/.test(type)) broken(`the bytes at ${at} are not a PNG chunk`);
    if (at + 12 + len > b.length) {
      broken(
        `its ${type} chunk declares ${len} bytes but the file ends ${at + 12 + len - b.length} bytes short`,
      );
    }
    if (crc32(b, at + 4, at + 8 + len) !== v.getUint32(at + 8 + len)) {
      broken(`its ${type} chunk at byte ${at} fails its checksum`);
    }
    if (n === 0) {
      if (type !== "IHDR" || len !== 13) broken("its first chunk is not IHDR");
      width = v.getUint32(at + 8);
      height = v.getUint32(at + 12);
    }
    if (type === "IDAT") idat = true;
    at += 12 + len;
    if (type === "IEND") break;
  }
  if (!idat) broken("it has no image data (IDAT)");
  return { width, height };
}

// --------------------------------------------------------------------------------------- JPEG

function jpeg(b: Uint8Array) {
  let at = 2;
  let size: { width: number; height: number } | null = null;
  let scanned = false;
  for (;;) {
    if (at >= b.length)
      broken(scanned ? "it ends before its end marker (EOI)" : "it ends before its image data");
    if (b[at] !== 0xff) broken(`the bytes at ${at} are not a JPEG marker`);
    while (b[at] === 0xff) at++; // fill bytes
    if (at >= b.length) broken("it ends before its end marker (EOI)");
    const m = b[at++] as number;
    if (m === 0xd9) break; // EOI
    if (m === 0x01 || (m >= 0xd0 && m <= 0xd7)) continue; // standalone markers
    if (at + 2 > b.length) broken("it ends inside a segment");
    const len = ((b[at] as number) << 8) | (b[at + 1] as number);
    if (len < 2 || at + len > b.length) broken(`a segment at byte ${at - 2} runs past the end`);
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
      if (len < 8) broken("its frame header (SOF) is too short");
      const height = ((b[at + 3] as number) << 8) | (b[at + 4] as number);
      const width = ((b[at + 5] as number) << 8) | (b[at + 6] as number);
      size ??= { width, height };
    }
    at += len;
    if (m === 0xda) {
      if (!size) broken("its image data comes before a frame header (SOF)");
      scanned = true;
      // Entropy-coded data runs to the next marker that is not a stuffed 0xFF00 or a restart.
      for (;;) {
        if (at + 1 >= b.length)
          broken("it ends inside its image data, before its end marker (EOI)");
        if (b[at] === 0xff) {
          const n = b[at + 1] as number;
          if (n !== 0x00 && !(n >= 0xd0 && n <= 0xd7) && n !== 0xff) break;
        }
        at++;
      }
    }
  }
  if (!size) broken("it has no frame header (SOF)");
  if (!scanned) broken("it has no image data (SOS)");
  return size as { width: number; height: number };
}

// ---------------------------------------------------------------------------------------- GIF

function gif(b: Uint8Array) {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const width = v.getUint16(6, true);
  const height = v.getUint16(8, true);
  const flags = b[10] as number;
  let at = 13 + (flags & 0x80 ? 3 * (1 << ((flags & 7) + 1)) : 0);
  const subBlocks = () => {
    for (;;) {
      if (at >= b.length) broken("it ends inside a block, before its trailer");
      const n = b[at++] as number;
      if (n === 0) return;
      at += n;
    }
  };
  let images = 0;
  for (;;) {
    if (at >= b.length) broken("it ends before its trailer");
    const k = b[at++];
    if (k === 0x3b) break;
    if (k === 0x21) {
      at++; // label
      subBlocks();
    } else if (k === 0x2c) {
      if (at + 9 > b.length) broken("it ends inside an image descriptor");
      const local = b[at + 8] as number;
      at += 9 + (local & 0x80 ? 3 * (1 << ((local & 7) + 1)) : 0);
      at++; // LZW minimum code size
      subBlocks();
      images++;
    } else broken(`the byte at ${at - 1} is not a GIF block`);
  }
  if (images === 0) broken("it has no image");
  return { width, height };
}

// --------------------------------------------------------------------------------------- WebP

function webp(b: Uint8Array) {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const riff = v.getUint32(4, true);
  if (riff + 8 > b.length)
    broken(`its RIFF header declares ${riff + 8} bytes but it has ${b.length}`);
  const end = riff + 8;
  let at = 12;
  let size: { width: number; height: number } | null = null;
  while (at < end) {
    if (at + 8 > end) broken("a chunk header runs past the RIFF size");
    const type = ascii(b, at, 4);
    const len = v.getUint32(at + 4, true);
    const data = at + 8;
    if (data + len > end) broken(`its ${type.trim()} chunk runs past the RIFF size`);
    if (!size) {
      if (type === "VP8X") {
        if (len < 10) broken("its VP8X chunk is too short");
        size = {
          width:
            1 +
            (b[data + 4] as number) +
            ((b[data + 5] as number) << 8) +
            ((b[data + 6] as number) << 16),
          height:
            1 +
            (b[data + 7] as number) +
            ((b[data + 8] as number) << 8) +
            ((b[data + 9] as number) << 16),
        };
      } else if (type === "VP8 ") {
        if (len < 10 || b[data + 3] !== 0x9d || b[data + 4] !== 0x01 || b[data + 5] !== 0x2a) {
          broken("its VP8 frame has no start code");
        }
        size = {
          width: v.getUint16(data + 6, true) & 0x3fff,
          height: v.getUint16(data + 8, true) & 0x3fff,
        };
      } else if (type === "VP8L") {
        if (len < 5 || b[data] !== 0x2f) broken("its VP8L frame has no signature");
        const bits = v.getUint32(data + 1, true);
        size = { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
      } else broken(`its first chunk is ${JSON.stringify(type)}, not VP8, VP8L or VP8X`);
    }
    at = data + len + (len & 1);
  }
  if (!size) broken("it has no image chunk");
  return size as { width: number; height: number };
}

// --------------------------------------------------------------------------------------- AVIF

function avifBrand(b: Uint8Array): boolean {
  if (b.length < 16) return false;
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const size = Math.min(v.getUint32(0), b.length);
  for (let at = 8; at + 4 <= size; at += 4) {
    if (at === 12) continue; // minor version
    const brand = ascii(b, at, 4);
    if (brand === "avif" || brand === "avis") return true;
  }
  return false;
}

/** ISO-BMFF boxes from `from` to `to`, each as [type, start of its payload, end]. */
function boxes(b: Uint8Array, from: number, to: number): [string, number, number][] {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const out: [string, number, number][] = [];
  let at = from;
  while (at < to) {
    if (at + 8 > to) broken(`a box header at byte ${at} runs past its container`);
    let size = v.getUint32(at);
    const type = ascii(b, at + 4, 4);
    let head = 8;
    if (size === 1) {
      if (at + 16 > to) broken(`the ${type} box's size runs past its container`);
      size = Number(v.getBigUint64(at + 8));
      head = 16;
    } else if (size === 0) size = to - at;
    if (size < head || at + size > to) {
      broken(`its ${type} box declares ${size} bytes but ${to - at} remain`);
    }
    out.push([type, at + head, at + size]);
    at += size;
  }
  return out;
}

function avif(b: Uint8Array) {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const top = boxes(b, 0, b.length);
  if (top[0]?.[0] !== "ftyp") broken("it does not start with an ftyp box");
  const meta = top.find((x) => x[0] === "meta");
  if (!meta) broken("it has no meta box");
  if (!top.some((x) => x[0] === "mdat")) broken("it has no image data (mdat)");
  const [, mStart, mEnd] = meta as [string, number, number];
  let best = { width: 0, height: 0 };
  // meta is a full box (4 bytes of version and flags); the sizes are in iprp > ipco > ispe.
  for (const [t, s, e] of boxes(b, mStart + 4, mEnd)) {
    if (t !== "iprp") continue;
    for (const [t2, s2, e2] of boxes(b, s, e)) {
      if (t2 !== "ipco") continue;
      for (const [t3, s3, e3] of boxes(b, s2, e2)) {
        if (t3 !== "ispe" || e3 - s3 < 12) continue;
        const width = v.getUint32(s3 + 4);
        const height = v.getUint32(s3 + 8);
        // The primary image is the largest (a grid's tiles and an alpha plane are no bigger).
        if (width * height > best.width * best.height) best = { width, height };
      }
    }
  }
  return best;
}

// ---------------------------------------------------------------------------------------- SVG

const SVG_NS = "http://www.w3.org/2000/svg";

/** The SVG's root start tag, if the text's first element is `<svg>` (prolog skipped). */
function svgRoot(b: Uint8Array): string | null {
  const head = b.subarray(0, 4096);
  if (head.includes(0)) return null;
  const text = new TextDecoder().decode(head);
  const m =
    /^﻿?\s*(?:<\?xml[^>]*\?>\s*)?(?:(?:<!--[\s\S]*?-->|<!DOCTYPE[^>[]*(?:\[[\s\S]*?\])?\s*>)\s*)*<svg(?=[\s/>])([^>]*)>/i.exec(
      text,
    );
  return m ? (m[1] ?? "") : null;
}

const attr = (tag: string, name: string) =>
  new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`)
    .exec(tag)
    ?.slice(1)
    .find((x) => x !== undefined);

const length = (s: string | undefined) => {
  const m = s ? /^\s*([0-9]*\.?[0-9]+)\s*(px)?\s*$/.exec(s) : null;
  return m ? Math.round(Number(m[1])) : 0;
};

function svg(b: Uint8Array) {
  const tag = svgRoot(b);
  if (tag === null) broken("its root element is not <svg>");
  const root = tag as string;
  if (attr(root, "xmlns") !== SVG_NS) broken(`its <svg> root does not declare xmlns="${SVG_NS}"`);
  const text = new TextDecoder().decode(b);
  const selfClosed = root.trimEnd().endsWith("/");
  const rest = text.replace(/(?:\s|<!--[\s\S]*?-->)*$/, "");
  if (!selfClosed && !/<\/svg\s*>$/i.test(rest)) broken("it does not end with </svg>");
  let width = length(attr(root, "width"));
  let height = length(attr(root, "height"));
  if (!width || !height) {
    const box = attr(root, "viewBox")
      ?.trim()
      .split(/[\s,]+/)
      .map(Number);
    if (box?.length === 4 && box.every(Number.isFinite)) {
      width ||= Math.round(box[2] as number);
      height ||= Math.round(box[3] as number);
    }
  }
  return width > 0 && height > 0 ? { width, height } : { width: 0, height: 0 };
}

const CHECKS: Record<ImageFormat, (b: Uint8Array) => { width: number; height: number }> = {
  png,
  jpeg,
  gif,
  webp,
  avif,
  svg,
};
