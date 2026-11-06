import { isDrawnDiagram } from "./diagram-export";
import type { Caller } from "./feed";
import type { FigureFact } from "./format/figures";
import { sha256Hex } from "./format/hash";
import { normalizePath } from "./format/paths";
import { checkAttachment, formatOf, imageInfo, videoSizeInRanges } from "./media";
import { recordCost } from "./op-costs";
import { StoreError } from "./store/errors";
import type { Reading } from "./store/reads";
import type { RowCost, RowTally } from "./store/sql";
import type { BlobRef, ImageRef, ImportFile, LibraryStore, WriteOp } from "./store/store";

/** Store methods the Worker may call on a library, over DO RPC or in process. */
export const LIBRARY_METHODS = [
  "apply",
  "import",
  "revert",
  "read",
  "page",
  // The app's read of the page it shows (TEMPRA-220): counted, never a write.
  "viewed",
  "tree",
  "outline",
  "pages",
  "search",
  "grep",
  "links",
  "events",
  "requests",
  "request",
  "changed",
  "history",
  "exportBundle",
  "headSeq",
  "sources",
  "diff",
  "work",
  "verify",
  "comment",
  "comments",
  "thread",
  "summary",
  "health",
  "needs",
  "signDownload",
  "openDownload",
  "signUpload",
  "openUpload",
  "dump",
  "pruneUsage",
  "maintenance",
  "setMaintenance",
  "stats",
  "contributors",
  "setDimensions",
  "imageBlob",
  "mediaBlob",
  "setDiagramRenders",
] as const;

export type LibraryMethod = (typeof LIBRARY_METHODS)[number];

// biome-ignore lint/suspicious/noExplicitAny: mapping arbitrary method signatures
type Fn = (...args: any[]) => any;

/** The async view of LibraryStore that route handlers use. */
export type LibraryClient = {
  [K in LibraryMethod]: LibraryStore[K] extends Fn
    ? (...args: Parameters<LibraryStore[K]>) => Promise<ReturnType<LibraryStore[K]>>
    : never;
};

/**
 * Errors cross the DO boundary as data, since RPC does not keep an Error's fields. `cost` is the
 * rows the call read and wrote, when the object counts them (TEMPRA-228).
 */
export type CallResult = (
  | { ok: true; value: unknown }
  | { ok: false; status: number; code: string; message: string; extra: Record<string, unknown> }
) & { cost?: RowCost };

/**
 * One call to a library. `caller` is who makes it (feed.ts `Caller`): an agent's reads are
 * presence (TEMPRA-219), and every read is counted as its surface and reader kind (TEMPRA-220).
 * Null for the Worker's own calls.
 */
export type CallFn = (
  method: LibraryMethod,
  args: unknown[],
  caller?: Caller | null,
) => Promise<CallResult>;

export function makeClient(call: CallFn, caller: Caller | null = null): LibraryClient {
  const client: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
  for (const m of LIBRARY_METHODS) {
    client[m] = async (...args: unknown[]) => {
      const t = Date.now();
      const r = await call(m, args, caller);
      // Added to the request's cost, when it is measured (costs.ts, TEMPRA-228).
      recordCost(m, args, r.cost, Date.now() - t);
      if (r.ok) return r.value;
      throw new StoreError(r.status, r.code, r.message, r.extra);
    };
  }
  return client as unknown as LibraryClient;
}

/** Content-addressed attachment bytes, `blobs/<sha256>` in R2 (spec: Backend architecture). */
export interface BlobStore {
  put(hash: string, bytes: Uint8Array, media: string | null): Promise<void>;
  /**
   * The blob's bytes; with `range`, only `length` bytes from `offset` (a video's seeking,
   * TEMPRA-164), `size` still the whole blob's.
   */
  get(
    hash: string,
    range?: BlobRange,
  ): Promise<{ body: ReadableStream | Uint8Array; size: number } | null>;
  head(hash: string): Promise<{ size: number } | null>;
}

/** Part of a blob: `length` bytes from `offset`. */
export interface BlobRange {
  offset: number;
  length: number;
}

export const blobKey = (hash: string) => `blobs/${hash}`;

export function r2BlobStore(bucket: R2Bucket): BlobStore {
  return {
    async put(hash, bytes, media) {
      await bucket.put(blobKey(hash), bytes, {
        sha256: hash,
        httpMetadata: media ? { contentType: media } : undefined,
      });
    },
    async get(hash, range) {
      const obj = await bucket.get(blobKey(hash), range ? { range } : undefined);
      return obj ? { body: obj.body, size: obj.size } : null;
    },
    async head(hash) {
      const obj = await bucket.head(blobKey(hash));
      return obj ? { size: obj.size } : null;
    },
  };
}

/**
 * Records each blob in the blob sweep's D1 (blobrefs.ts) before its bytes go up, so the sweep
 * knows what is stored without listing the bucket (TEMPRA-81). If the record fails, nothing is
 * uploaded.
 */
export function recordingBlobStore(
  inner: BlobStore,
  refs: { stored(hash: string, at: Date): Promise<void> },
): BlobStore {
  return {
    ...inner,
    async put(hash, bytes, media) {
      await refs.stored(hash, new Date());
      await inner.put(hash, bytes, media);
    },
  };
}

/** The attachments a call would commit: attach ops in `apply`, blob files in `import`. */
export function attachedBlobs(
  method: LibraryMethod,
  args: unknown[],
): { path: string; blob: BlobRef }[] {
  const refs: { path: string; blob: BlobRef }[] = [];
  if (method === "apply") {
    for (const op of (args[1] as WriteOp[]) ?? []) if (op.op === "attach") refs.push(op);
  } else if (method === "import") {
    for (const f of (args[1] as ImportFile[]) ?? []) if ("blob" in f) refs.push(f);
  }
  return refs;
}

/**
 * Confirms each attachment a request commits exists in blob storage with the declared size
 * (spec: Write path, step 3). Runs before the synchronous write transaction.
 */
export async function verifyBlobs(
  blobs: BlobStore,
  method: LibraryMethod,
  args: unknown[],
): Promise<void> {
  await Promise.all(
    attachedBlobs(method, args).map(async ({ path, blob }) => {
      const head = await blobs.head(blob.hash);
      if (!head) {
        throw new StoreError(400, "blob_missing", `No uploaded bytes for ${path} (${blob.hash}).`);
      }
      if (head.size !== blob.size) {
        throw new StoreError(
          400,
          "blob_size",
          `Uploaded size for ${path} is ${head.size}, not ${blob.size}.`,
        );
      }
    }),
  );
}

/** Runs a store method, turning thrown StoreErrors into data. Shared by the DO and tests. */
/**
 * Calls that can add to a library, refused once it is at its storage limit. Deletes and moves
 * always go through, so a full library can be cleared.
 */
export function grows(method: LibraryMethod, args: unknown[]): boolean {
  if (method === "import" || method === "revert" || method === "comment") return true;
  if (method !== "apply") return false;
  const ops = (args[1] ?? []) as { op?: string }[];
  return ops.some((o) => o.op !== "delete" && o.op !== "move");
}

export async function callStore(
  store: LibraryStore,
  blobs: BlobStore,
  method: LibraryMethod,
  args: unknown[],
  opts: {
    storageLimitBytes?: number;
    /**
     * Records that the library references these blobs (the blob sweep's D1, TEMPRA-91), before
     * the write that adds them commits; a write it cannot record is refused, never committed.
     */
    references?: (hashes: string[]) => Promise<void>;
    /** Who reads, for read history (TEMPRA-220); null for the Worker's own calls. */
    reading?: Reading | null;
    /**
     * Counts the store's rows (TEMPRA-228): the call's cost, from just before its synchronous
     * part, comes back with its result.
     */
    rows?: RowTally;
  } = {},
): Promise<CallResult> {
  let mark: RowCost | undefined;
  const costed = <R extends CallResult>(r: R): R =>
    opts.rows && mark ? { ...r, cost: opts.rows.since(mark) } : r;
  try {
    if (!LIBRARY_METHODS.includes(method)) {
      throw new StoreError(400, "bad_method", `Unknown library method ${method}.`);
    }
    const limit = opts.storageLimitBytes;
    if (limit !== undefined && grows(method, args) && store.storageBytes() >= limit) {
      throw new StoreError(
        507,
        "storage_full",
        `This library is at its storage limit of ${Math.round(limit / 1048576)} MB. Delete or move content to free space.`,
      );
    }
    await verifyBlobs(blobs, method, args);
    // Only blobs new to this library cost a D1 call: a text write, or an attachment the library
    // already holds (its reference is recorded already, or its first count will find it), never do.
    const attached = opts.references ? attachedBlobs(method, args).map((a) => a.blob.hash) : [];
    const held = attached.length > 0 ? store.hasBlobs(attached) : new Set<string>();
    const fresh = [...new Set(attached)].filter((h) => !held.has(h));
    if (opts.references && fresh.length > 0) {
      try {
        await opts.references(fresh);
      } catch (e) {
        console.error("blob references not recorded", e);
        throw new StoreError(
          503,
          "unavailable",
          "Could not record the attachment for this library; nothing was written. Try again.",
        );
      }
    }
    const fn = store[method] as unknown as (...a: unknown[]) => unknown;
    mark = opts.rows?.mark();
    const value = store.reading(opts.reading ?? null, () => fn.apply(store, args));
    return costed({ ok: true, value });
  } catch (e) {
    if (e instanceof StoreError) {
      return costed({
        ok: false,
        status: e.status,
        code: e.code,
        message: e.message,
        extra: e.extra,
      });
    }
    throw e;
  }
}

/** Attachments that pass through the Worker (Phase 1 has no presigned uploads). */
export const WORKER_ATTACHMENT_CAP = 10 * 1024 * 1024;

/**
 * Stores attachment bytes by hash (the key is content-addressed, so orphans are harmless), after
 * `checkAttachment` (media.ts, TEMPRA-152): a broken image is refused with 400 `bad_image` before
 * anything is stored, an image's type comes from its bytes (`declared`, the header's or the
 * extension's, is ignored when it disagrees, and the returned `note` says so), and its width and
 * height come back for the attach op. Every way bytes come in goes through here.
 */
export async function putBlob(
  blobs: BlobStore,
  bytes: Uint8Array,
  declared: string | null,
  path?: string,
): Promise<BlobRef> {
  if (bytes.length > WORKER_ATTACHMENT_CAP) {
    throw new StoreError(
      413,
      "attachment_too_large",
      `Attachments through the Worker are capped at ${WORKER_ATTACHMENT_CAP} bytes.`,
    );
  }
  const info = checkAttachment(bytes, declared, path);
  const hash = sha256Hex(bytes);
  await blobs.put(hash, bytes, info.media);
  return { hash, size: bytes.length, ...info };
}

async function blobBytes(blobs: BlobStore, hash: string): Promise<Uint8Array | null> {
  const obj = await blobs.get(hash);
  if (!obj) return null;
  return obj.body instanceof Uint8Array
    ? obj.body
    : new Uint8Array(await new Response(obj.body).arrayBuffer());
}

/**
 * An attach op's blob for bytes uploaded before (by hash: REST `X-Blob`, a batch's `attach`),
 * checked like `putBlob` checks new bytes; 400 `blob_missing` when nothing is stored there.
 */
export async function describeBlob(
  blobs: BlobStore,
  hash: string,
  declared: string | null,
  path?: string,
): Promise<BlobRef> {
  const bytes = /^[0-9a-f]{64}$/.test(hash) ? await blobBytes(blobs, hash) : null;
  if (!bytes) throw new StoreError(400, "blob_missing", `No uploaded bytes for ${hash}.`);
  return { hash, size: bytes.length, ...checkAttachment(bytes, declared, path) };
}

/** Videos whose frame size their header gives (media.ts `videoSize`; TEMPRA-164, TEMPRA-183). */
const SIZED_VIDEO = new Set(["video/mp4", "video/webm"]);

/** Whether a file's pixel size can be worked out from its bytes: an image, or an MP4 or WebM video. */
const sizable = (media: string | null | undefined): media is string =>
  !!media && (media.startsWith("image/") || SIZED_VIDEO.has(media));

/**
 * An attachment's view with its width and height, worked out once from its bytes for an image
 * stored before dimensions were (TEMPRA-152) or a video stored before TEMPRA-164 (TEMPRA-183),
 * and kept with `setDimensions`; one that does not decode is kept as 0 by 0, so it is never read
 * again (TEMPRA-185). Views of other files pass through.
 */
export async function withDimensions<V extends { kind: string }>(
  lib: Pick<LibraryClient, "setDimensions">,
  blobs: BlobStore,
  view: V,
): Promise<V> {
  const a = view as unknown as {
    kind: string;
    hash: string;
    media: string | null;
    width?: number | null;
  };
  if (a.kind !== "attachment" || a.width !== undefined || !sizable(a.media)) return view;
  const dims = await workOutDimensions(lib, blobs, a.hash, a.media);
  return dims && dims.width > 0 && dims.height > 0 ? { ...view, ...dims } : view;
}

/**
 * An image's or a video's width and height from its bytes, kept with `setDimensions`, 0 by 0 when
 * they do not decode, so the next read finds it settled and leaves R2 alone (TEMPRA-185). An image
 * is read whole; a video only in ranges, its first bytes and, for an MP4, its box headers and
 * `moov` (`videoSizeInRanges`; TEMPRA-183). Null, and nothing kept, when the bytes are missing.
 */
async function workOutDimensions(
  lib: Pick<LibraryClient, "setDimensions">,
  blobs: BlobStore,
  hash: string,
  media: string,
): Promise<{ width: number; height: number } | null> {
  let size: { width: number; height: number } | null;
  if (media.startsWith("video/")) {
    const stored = await blobs.head(hash);
    if (!stored) return null;
    size = await videoSizeInRanges(
      async (offset, length) => {
        const obj = await blobs.get(hash, { offset, length });
        if (!obj) return null;
        return obj.body instanceof Uint8Array
          ? obj.body
          : new Uint8Array(await new Response(obj.body).arrayBuffer());
      },
      stored.size,
      media,
    );
  } else {
    const bytes = await blobBytes(blobs, hash);
    if (!bytes) return null;
    const info = imageInfo(bytes, formatOf(media));
    size = info?.ok ? { width: info.width, height: info.height } : null;
  }
  const width = size?.width ?? 0;
  const height = size?.height ?? 0;
  await lib.setDimensions(hash, width, height);
  return { width, height };
}

/** At most this many images a `read` of a page works out the size of (two at a time). */
export const FIGURE_DIMENSIONS_PER_READ = 6;

/**
 * A page's figures with the width and height of images stored before TEMPRA-152 worked out
 * (`blob.width` null), as `withDimensions` does for one attachment: each blob once, at most
 * FIGURE_DIMENSIONS_PER_READ a read, two at a time so a page of large images is not all in
 * memory at once; the rest are worked out by later reads.
 */
export async function figuresWithDimensions(
  lib: Pick<LibraryClient, "setDimensions">,
  blobs: BlobStore,
  figures: FigureFact[],
): Promise<FigureFact[]> {
  const todo = new Map<string, string>();
  for (const f of figures) {
    if (f.kind !== "image" || f.status !== "ok" || !f.blob || f.blob.width !== null) continue;
    if (!sizable(f.blob.media)) continue;
    if (todo.size >= FIGURE_DIMENSIONS_PER_READ) break;
    todo.set(f.blob.hash, f.blob.media);
  }
  if (todo.size === 0) return figures;
  const found = new Map<string, { width: number; height: number }>();
  const hashes = [...todo.keys()];
  for (let i = 0; i < hashes.length; i += 2) {
    await Promise.all(
      hashes.slice(i, i + 2).map(async (h) => {
        const dims = await workOutDimensions(lib, blobs, h, todo.get(h) as string).catch(
          () => null,
        );
        if (dims) found.set(h, dims);
      }),
    );
  }
  return figures.map((f) => {
    const dims = f.kind === "image" && f.blob ? found.get(f.blob.hash) : undefined;
    return dims && f.kind === "image" && f.blob ? { ...f, blob: { ...f.blob, ...dims } } : f;
  });
}

/**
 * A page's `images` (FileView) with every image's and video's size worked out, as
 * `withDimensions` does for one attachment, so the reader can reserve each one's box (TEMPRA-162,
 * TEMPRA-183). Null when it does not decode.
 */
export async function imagesWithDimensions(
  lib: Pick<LibraryClient, "setDimensions">,
  blobs: BlobStore,
  images: Record<string, ImageRef>,
): Promise<Record<string, ImageRef>> {
  const out: Record<string, ImageRef> = {};
  await Promise.all(
    Object.entries(images).map(async ([path, ref]) => {
      if (ref.width !== undefined || !sizable(ref.media)) {
        out[path] = ref;
        return;
      }
      const v = await withDimensions(lib, blobs, { kind: "attachment", path, ...ref });
      out[path] = { ...ref, width: v.width ?? null, height: v.height ?? null };
    }),
  );
  return out;
}

const MEDIA: Record<string, string> = {
  html: "text/html",
  py: "text/x-python",
  json: "application/json",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  svg: "image/svg+xml",
  webp: "image/webp",
  avif: "image/avif",
  mp4: "video/mp4",
  webm: "video/webm",
  mp3: "audio/mpeg",
  ogg: "audio/ogg",
  wav: "audio/wav",
  pdf: "application/pdf",
  txt: "text/plain",
  csv: "text/csv",
  sql: "application/sql",
};

export function mediaFor(path: string, header?: string | null): string | null {
  if (header && header !== "application/octet-stream") return header.split(";")[0]?.trim() ?? null;
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return MEDIA[ext] ?? null;
}

/**
 * Turns uploaded bundle files into import files: markdown as pages, everything else stored in
 * the blob store first. `strip` drops leading directories; dot-directories (.git, .obsidian) are
 * skipped, and so are drawn diagrams beside a page (`<page>.diagrams/<n>.svg`, TEMPRA-168),
 * which an export derives and an import never makes attachments of.
 */
export async function bundleFiles(
  blobs: BlobStore,
  raw: { path: string; bytes: Uint8Array }[],
  strip = 0,
): Promise<ImportFile[]> {
  const files: ImportFile[] = [];
  const paths = raw.map((f) => normalizePath(f.path.split("/").slice(strip).join("/")));
  const pages = new Set(paths.filter((p): p is string => !!p?.endsWith(".md")));
  for (const [i, f] of raw.entries()) {
    const path = paths[i];
    if (!path || path.split("/").some((s) => s.startsWith("."))) continue;
    if (isDrawnDiagram(path, pages)) continue;
    if (path.endsWith(".md")) files.push({ path, markdown: new TextDecoder().decode(f.bytes) });
    else files.push({ path, blob: await putBlob(blobs, f.bytes, mediaFor(path), path) });
  }
  if (files.length === 0) throw new StoreError(400, "empty_import", "No files found to import.");
  return files;
}
