import type { BlobStore } from "./client";
import { type DiagramExport, drawnDiagrams } from "./diagram-export";
import { StoreError } from "./store/errors";
import { EXPORT_FORMATS, type ExportFormat } from "./store/store";
import { readTar, tarEnd, tarHeader, tarPadding } from "./util/tar";

/**
 * Bundles as tar streams (TEMPRA-83; tempra-dev: v2/exports): text in memory, each attachment's
 * bytes piped from blob storage when the stream reaches it, so neither a person's export nor a
 * nightly folder's download holds a library's attachments in memory. Free of Worker APIs.
 */

/** An attachment a bundle names by hash; its bytes are at blobs/<hash>. */
export interface ExportAttachment {
  path: string;
  hash: string;
  size: number;
  media: string | null;
}

/** An entry of a streamed archive: text in memory, or an attachment read when it is reached. */
export type BundleEntry = { path: string; bytes: Uint8Array } | ExportAttachment;

const enc = new TextEncoder();

/**
 * A tar archive of the entries as a stream. An attachment whose bytes are missing, or whose bytes
 * are not as long as stored, ends the stream with an error rather than a short bundle.
 */
export function tarStream(
  entries: BundleEntry[],
  blobs: BlobStore,
  mtime = Math.floor(Date.now() / 1000),
): ReadableStream<Uint8Array> {
  let next = 0;
  let body: {
    reader: ReadableStreamDefaultReader<Uint8Array>;
    size: number;
    read: number;
    path: string;
  } | null = null;
  return new ReadableStream<Uint8Array>({
    async pull(out) {
      if (body) {
        const { done, value } = await body.reader.read();
        if (!done) {
          body.read += value.length;
          if (body.read > body.size) out.error(new Error(`Bytes for ${body.path} are too long.`));
          else out.enqueue(value);
          return;
        }
        if (body.read !== body.size) {
          out.error(new Error(`Bytes for ${body.path} are short.`));
          return;
        }
        out.enqueue(tarPadding(body.size));
        body = null;
        return;
      }
      const e = entries[next++];
      if (!e) {
        out.enqueue(tarEnd());
        out.close();
        return;
      }
      if ("bytes" in e) {
        out.enqueue(tarHeader(e.path, e.bytes.length, mtime));
        if (e.bytes.length > 0) out.enqueue(e.bytes);
        out.enqueue(tarPadding(e.bytes.length));
        return;
      }
      const obj = await blobs.get(e.hash);
      if (!obj) {
        out.error(new Error(`Bytes for ${e.path} are missing.`));
        return;
      }
      out.enqueue(tarHeader(e.path, obj.size, mtime));
      if (obj.body instanceof Uint8Array) {
        if (obj.body.length !== obj.size) {
          out.error(new Error(`Bytes for ${e.path} are short.`));
          return;
        }
        if (obj.size > 0) out.enqueue(obj.body);
        out.enqueue(tarPadding(obj.size));
        return;
      }
      body = { reader: obj.body.getReader(), size: obj.size, read: 0, path: e.path };
    },
    async cancel(reason) {
      await body?.reader.cancel(reason);
    },
  });
}

/**
 * A library's bundle at `at` as a tar stream, with attachments' bytes from blob storage. With
 * `diagrams`, each page's Mermaid, SVG and Vega-Lite fences are drawn beside it as SVG
 * (TEMPRA-168, TEMPRA-206, TEMPRA-207): on for the person's export. A chart's data file is read
 * from blob storage when a chart names it.
 */
export async function bundleStream(
  lib: { exportBundle(at?: number, format?: ExportFormat): unknown },
  blobs: BlobStore,
  at?: number,
  opts: { diagrams?: DiagramExport; format?: ExportFormat } = {},
): Promise<{ seq: number; files: number; body: ReadableStream<Uint8Array> }> {
  const bundle = (await lib.exportBundle(at, opts.format ?? "plain")) as {
    seq: number;
    files: {
      path: string;
      text?: string;
      blob?: { hash: string; size: number; media: string | null };
    }[];
  };
  const entries: BundleEntry[] = [];
  for (const f of bundle.files) {
    if (f.text !== undefined) entries.push({ path: f.path, bytes: enc.encode(f.text) });
    else if (f.blob) {
      entries.push({ path: f.path, hash: f.blob.hash, size: f.blob.size, media: f.blob.media });
    }
  }
  // Every attachment's bytes are there before the answer starts, so a missing one is still a
  // clear 500 rather than a download cut short. A HEAD each, a few at a time.
  const attachments = entries.filter((e): e is ExportAttachment => !("bytes" in e));
  for (let i = 0; i < attachments.length; i += 8) {
    const batch = attachments.slice(i, i + 8);
    const found = await Promise.all(batch.map((a) => blobs.head(a.hash)));
    const gone = batch.find((_, j) => !found[j]);
    if (gone) throw new StoreError(500, "blob_missing", `Bytes for ${gone.path} are missing.`);
  }
  if (opts.diagrams) {
    const byPath = new Map(entries.map((e) => [e.path, e]));
    const read = async (path: string) => {
      const e = byPath.get(path);
      if (!e) return null;
      if ("bytes" in e) return new TextDecoder().decode(e.bytes);
      const obj = await blobs.get(e.hash);
      return obj ? new Response(obj.body as BodyInit).text() : null;
    };
    for (const d of await drawnDiagrams(bundle.files, { read, ...opts.diagrams })) {
      entries.push({ path: d.path, bytes: enc.encode(d.svg) });
    }
  }
  return { seq: bundle.seq, files: entries.length, body: tarStream(entries, blobs) };
}

/** What `nightlyBundle` reads an export folder's files with (the R2 bucket's get). */
export type ReadExportFile = (key: string) => Promise<{ body: ReadableStream | Uint8Array } | null>;

const bytesOf = async (body: ReadableStream | Uint8Array) =>
  body instanceof Uint8Array ? body : new Uint8Array(await new Response(body).arrayBuffer());

/**
 * A nightly or pre-restore export folder's bundle, self-contained for download: a folder written
 * since TEMPRA-83 keeps its text in `bundle.tar` and names its attachments in `attachments.json`,
 * so their bytes are streamed in from blob storage after the text; an attachment already inside
 * the stored tar (a folder overwritten halfway from the old format) is not added twice. A folder
 * from before has the bytes inside and is served as stored. Null when the folder has no bundle.
 */
export async function nightlyBundle(
  folder: string,
  read: ReadExportFile,
  blobs: BlobStore,
): Promise<ReadableStream | Uint8Array | null> {
  const [list, tar] = await Promise.all([
    read(`${folder}attachments.json`),
    read(`${folder}bundle.tar`),
  ]);
  if (!tar) return null;
  if (!list) return tar.body;
  const text = readTar(await bytesOf(tar.body));
  const attachments = JSON.parse(
    new TextDecoder().decode(await bytesOf(list.body)),
  ) as ExportAttachment[];
  const have = new Set(text.map((f) => f.path));
  return tarStream([...text, ...attachments.filter((a) => !have.has(a.path))], blobs);
}

/** An export's `format` as asked: `plain` when not given; anything else is refused. */
export function exportFormat(raw: string | undefined): ExportFormat {
  const format = raw ?? "plain";
  if (!(EXPORT_FORMATS as readonly string[]).includes(format)) {
    throw new StoreError(400, "bad_format", "`format` is plain (the default) or okf.");
  }
  return format as ExportFormat;
}
