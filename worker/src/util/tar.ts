/** Minimal ustar reader and writer for bundle import and export (pax `path` for long names). */

export interface TarFile {
  path: string;
  bytes: Uint8Array;
}

const enc = new TextEncoder();
const dec = new TextDecoder();

function readString(b: Uint8Array, off: number, len: number): string {
  const slice = b.subarray(off, off + len);
  const nul = slice.indexOf(0);
  return dec.decode(nul === -1 ? slice : slice.subarray(0, nul));
}

function readOctal(b: Uint8Array, off: number, len: number): number {
  const s = readString(b, off, len).trim();
  return s ? Number.parseInt(s, 8) : 0;
}

function parsePax(data: Uint8Array): Record<string, string> {
  const out: Record<string, string> = {};
  let i = 0;
  while (i < data.length) {
    const space = data.indexOf(0x20, i);
    if (space === -1) break;
    const len = Number.parseInt(dec.decode(data.subarray(i, space)), 10);
    if (!len) break;
    const record = dec.decode(data.subarray(space + 1, i + len - 1));
    const eq = record.indexOf("=");
    if (eq !== -1) out[record.slice(0, eq)] = record.slice(eq + 1);
    i += len;
  }
  return out;
}

/** Regular files in a tar archive, in archive order. Directories and links are skipped. */
export function readTar(b: Uint8Array): TarFile[] {
  const files: TarFile[] = [];
  let off = 0;
  let longName: string | null = null;
  let pax: Record<string, string> = {};
  while (off + 512 <= b.length) {
    const header = b.subarray(off, off + 512);
    if (header.every((x) => x === 0)) break;
    const size = readOctal(header, 124, 12);
    const type = String.fromCharCode(header[156] ?? 0);
    const magic = readString(header, 257, 6);
    const prefix = magic.startsWith("ustar") ? readString(header, 345, 155) : "";
    let name = readString(header, 0, 100);
    if (prefix) name = `${prefix}/${name}`;
    const data = b.subarray(off + 512, off + 512 + size);
    off += 512 + Math.ceil(size / 512) * 512;
    if (type === "x") {
      pax = parsePax(data);
      continue;
    }
    if (type === "g") continue;
    if (type === "L") {
      longName = readString(data, 0, data.length);
      continue;
    }
    const path = pax.path ?? longName ?? name;
    longName = null;
    pax = {};
    if (type === "0" || type === "\0" || type === "7") files.push({ path, bytes: data.slice() });
  }
  return files;
}

function writeOctal(h: Uint8Array, off: number, len: number, value: number) {
  h.set(enc.encode(`${value.toString(8).padStart(len - 1, "0")}\0`), off);
}

function header(name: string, size: number, type: string, mtime: number): Uint8Array {
  const h = new Uint8Array(512);
  h.set(enc.encode(name).subarray(0, 100), 0);
  writeOctal(h, 100, 8, 0o644);
  writeOctal(h, 108, 8, 0);
  writeOctal(h, 116, 8, 0);
  writeOctal(h, 124, 12, size);
  writeOctal(h, 136, 12, mtime);
  h.fill(0x20, 148, 156);
  h[156] = type.charCodeAt(0);
  h.set(enc.encode("ustar\0"), 257);
  h.set(enc.encode("00"), 263);
  let sum = 0;
  for (const x of h) sum += x;
  h.set(enc.encode(`${sum.toString(8).padStart(6, "0")}\0 `), 148);
  return h;
}

function paxRecord(key: string, value: string): Uint8Array {
  // The length prefix counts its own digits.
  const body = enc.encode(` ${key}=${value}\n`).length;
  let len = body + String(body).length;
  if (String(len).length + body !== len) len = String(len).length + body;
  return enc.encode(`${len} ${key}=${value}\n`);
}

function pad(n: number): Uint8Array {
  return new Uint8Array((512 - (n % 512)) % 512);
}

/** A tar archive of the files, with pax headers for paths over 100 bytes. */
export function writeTar(files: TarFile[], mtime = Math.floor(Date.now() / 1000)): Uint8Array {
  const parts: Uint8Array[] = [];
  for (const f of files) {
    if (enc.encode(f.path).length > 100) {
      const rec = paxRecord("path", f.path);
      parts.push(header("PaxHeader", rec.length, "x", mtime), rec, pad(rec.length));
    }
    parts.push(header(f.path, f.bytes.length, "0", mtime), f.bytes, pad(f.bytes.length));
  }
  parts.push(new Uint8Array(1024));
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

/** Gunzips when the bytes start with the gzip magic number. */
export async function maybeGunzip(b: Uint8Array): Promise<Uint8Array> {
  if (b[0] !== 0x1f || b[1] !== 0x8b) return b;
  const stream = new Response(b).body?.pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
