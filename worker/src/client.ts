import { sha256Hex } from "./okf/hash";
import { normalizePath } from "./okf/paths";
import { OkfError } from "./store/errors";
import type { BlobRef, ImportFile, LibraryStore, WriteOp } from "./store/store";
import { writeTar } from "./util/tar";

/** Store methods the Worker may call on a library, over DO RPC or in process. */
export const LIBRARY_METHODS = [
  "apply",
  "import",
  "revert",
  "read",
  "tree",
  "concepts",
  "search",
  "grep",
  "links",
  "events",
  "requests",
  "request",
  "history",
  "exportBundle",
  "headSeq",
  "sources",
  "diff",
  "work",
  "verify",
  "summary",
  "signDownload",
  "openDownload",
  "dump",
  "pruneUsage",
  "maintenance",
  "setMaintenance",
  "stats",
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

/** Errors cross the DO boundary as data, since RPC does not keep an Error's fields. */
export type CallResult =
  | { ok: true; value: unknown }
  | { ok: false; status: number; code: string; message: string; extra: Record<string, unknown> };

export type CallFn = (method: LibraryMethod, args: unknown[]) => Promise<CallResult>;

export function makeClient(call: CallFn): LibraryClient {
  const client: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
  for (const m of LIBRARY_METHODS) {
    client[m] = async (...args: unknown[]) => {
      const r = await call(m, args);
      if (r.ok) return r.value;
      throw new OkfError(r.status, r.code, r.message, r.extra);
    };
  }
  return client as unknown as LibraryClient;
}

/** Content-addressed attachment bytes, `blobs/<sha256>` in R2 (spec: Backend architecture). */
export interface BlobStore {
  put(hash: string, bytes: Uint8Array, media: string | null): Promise<void>;
  get(hash: string): Promise<{ body: ReadableStream | Uint8Array; size: number } | null>;
  head(hash: string): Promise<{ size: number } | null>;
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
    async get(hash) {
      const obj = await bucket.get(blobKey(hash));
      return obj ? { body: obj.body, size: obj.size } : null;
    },
    async head(hash) {
      const obj = await bucket.head(blobKey(hash));
      return obj ? { size: obj.size } : null;
    },
  };
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
  const refs: { path: string; blob: BlobRef }[] = [];
  if (method === "apply") {
    for (const op of (args[1] as WriteOp[]) ?? []) if (op.op === "attach") refs.push(op);
  } else if (method === "import") {
    for (const f of (args[1] as ImportFile[]) ?? []) if ("blob" in f) refs.push(f);
  }
  await Promise.all(
    refs.map(async ({ path, blob }) => {
      const head = await blobs.head(blob.hash);
      if (!head) {
        throw new OkfError(400, "blob_missing", `No uploaded bytes for ${path} (${blob.hash}).`);
      }
      if (head.size !== blob.size) {
        throw new OkfError(
          400,
          "blob_size",
          `Uploaded size for ${path} is ${head.size}, not ${blob.size}.`,
        );
      }
    }),
  );
}

/** Runs a store method, turning thrown OkfErrors into data. Shared by the DO and tests. */
export async function callStore(
  store: LibraryStore,
  blobs: BlobStore,
  method: LibraryMethod,
  args: unknown[],
): Promise<CallResult> {
  try {
    if (!LIBRARY_METHODS.includes(method)) {
      throw new OkfError(400, "bad_method", `Unknown library method ${method}.`);
    }
    await verifyBlobs(blobs, method, args);
    const fn = store[method] as unknown as (...a: unknown[]) => unknown;
    return { ok: true, value: fn.apply(store, args) };
  } catch (e) {
    if (e instanceof OkfError) {
      return { ok: false, status: e.status, code: e.code, message: e.message, extra: e.extra };
    }
    throw e;
  }
}

/** Attachments that pass through the Worker (Phase 1 has no presigned uploads). */
export const WORKER_ATTACHMENT_CAP = 10 * 1024 * 1024;

/** Stores attachment bytes by hash (the key is content-addressed, so orphans are harmless). */
export async function putBlob(blobs: BlobStore, bytes: Uint8Array, media: string | null) {
  if (bytes.length > WORKER_ATTACHMENT_CAP) {
    throw new OkfError(
      413,
      "attachment_too_large",
      `Attachments through the Worker are capped at ${WORKER_ATTACHMENT_CAP} bytes.`,
    );
  }
  const hash = sha256Hex(bytes);
  await blobs.put(hash, bytes, media);
  return { hash, size: bytes.length, media };
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
 * Turns uploaded bundle files into import files: markdown as concepts, everything else stored in
 * the blob store first. `strip` drops leading directories; dot-directories (.git, .obsidian) are
 * skipped.
 */
export async function bundleFiles(
  blobs: BlobStore,
  raw: { path: string; bytes: Uint8Array }[],
  strip = 0,
): Promise<ImportFile[]> {
  const files: ImportFile[] = [];
  for (const f of raw) {
    const path = normalizePath(f.path.split("/").slice(strip).join("/"));
    if (!path || path.split("/").some((s) => s.startsWith("."))) continue;
    if (path.endsWith(".md")) files.push({ path, markdown: new TextDecoder().decode(f.bytes) });
    else files.push({ path, blob: await putBlob(blobs, f.bytes, mediaFor(path)) });
  }
  if (files.length === 0) throw new OkfError(400, "empty_import", "No files found to import.");
  return files;
}

/** A library's bundle as tar bytes, attachments read from blob storage (spec: Reads and export). */
export async function bundleTar(
  lib: { exportBundle(at?: number): unknown },
  blobs: BlobStore,
  at?: number,
): Promise<{ seq: number; bytes: Uint8Array; files: number }> {
  const bundle = (await lib.exportBundle(at)) as {
    seq: number;
    files: { path: string; text?: string; blob?: { hash: string } }[];
  };
  const enc = new TextEncoder();
  const files: { path: string; bytes: Uint8Array }[] = [];
  for (const f of bundle.files) {
    if (f.text !== undefined) files.push({ path: f.path, bytes: enc.encode(f.text) });
    else if (f.blob) {
      const obj = await blobs.get(f.blob.hash);
      if (!obj) throw new OkfError(500, "blob_missing", `Bytes for ${f.path} are missing.`);
      const bytes =
        obj.body instanceof Uint8Array
          ? obj.body
          : new Uint8Array(await new Response(obj.body).arrayBuffer());
      files.push({ path: f.path, bytes });
    }
  }
  return { seq: bundle.seq, bytes: writeTar(files), files: files.length };
}
