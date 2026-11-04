import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { sha256Hex } from "../src/format/hash";
import { LibraryStore } from "../src/store/store";
import { readTar, writeTar } from "../src/util/tar";
import { API, setup } from "./harness";
import { base64, makePng, SAMPLES, SVG, sample, truncatedIdatPng } from "./images";
import { bunSqlHandle } from "./sqlite";
import { attachFile } from "./upload";

type S = ReturnType<typeof setup>;
type Text = { type: "text"; text: string };

const describeFile = async (s: S, path: string) =>
  (await (
    await s.app.request(`${API}/files/${path}`, { headers: { Accept: "application/json" } })
  ).json()) as Record<string, unknown>;

const put = (s: S, path: string, body: Uint8Array, type: string, headers = {}) =>
  s.req(`/files/${path}`, {
    method: "PUT",
    headers: { "Content-Type": type, ...headers },
    body: body as unknown as BodyInit,
  });

/** Bytes stored as they were before TEMPRA-152: by the store alone, any type, no size. */
function legacyAttach(s: S, path: string, bytes: Uint8Array, media: string) {
  const hash = sha256Hex(bytes);
  s.blobs.map.set(hash, bytes);
  return s
    .store()
    .apply({ actor: "test/old", request_id: crypto.randomUUID() }, [
      { op: "attach", path, blob: { hash, size: bytes.length, media } },
    ]);
}

async function mcp(s: S) {
  const transport = new StreamableHTTPClientTransport(new URL("http://localhost/mcp"), {
    requestInit: { headers: { Authorization: "Bearer writer" } },
    fetch: async (url, init) => s.app.request(url.toString(), init as RequestInit),
  });
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(transport);
  return async (name: string, args: Record<string, unknown> = {}) => {
    const r = await client.callTool({ name, arguments: args });
    return { text: (r.content as Text[]).map((c) => c.text).join("\n"), isError: !!r.isError };
  };
}

describe("attachments: checked images, type from the bytes, dimensions (TEMPRA-152)", () => {
  test("REST PUT: every format stored with its type and size; the declared type ignored", async () => {
    const s = setup();
    for (const x of SAMPLES) {
      const r = await put(s, `img/${x.file}.bin`, sample(x.file), "application/pdf");
      expect(r.status).toBe(200);
      const body = (await r.json()) as { notices?: { code: string }[] };
      expect(body.notices?.map((n) => n.code)).toEqual(["media_from_bytes"]);
      expect(await describeFile(s, `img/${x.file}.bin`)).toMatchObject({
        kind: "attachment",
        media: x.media,
        width: x.width,
        height: x.height,
      });
    }
    const svg = await put(s, "img/mark.svg", SVG, "image/svg+xml");
    expect(((await svg.json()) as { notices?: unknown }).notices).toBeUndefined();
    expect(await describeFile(s, "img/mark.svg")).toMatchObject({ width: 120, height: 60 });
    // Not an image: no size, as before.
    await put(s, "data.csv", new TextEncoder().encode("a,b\n"), "text/csv");
    expect(await describeFile(s, "data.csv")).toMatchObject({
      media: "text/csv",
      width: null,
      height: null,
    });
  });

  test("a broken image is refused on every way in, and nothing is written", async () => {
    const s = setup();
    const broken = truncatedIdatPng();
    const r = await put(s, "assets/attach-test.png", broken, "image/png");
    expect(r.status).toBe(400);
    const err = (await r.json()) as { code: string; error: string };
    expect(err.code).toBe("bad_image");
    expect(err.error).toContain("assets/attach-test.png is not a valid PNG");
    expect(s.blobs.map.size).toBe(0);
    expect((await s.req("/files/assets/attach-test.png")).status).toBe(404);

    // By hash (X-Blob, batch): bytes stored before are checked the same way.
    const hash = sha256Hex(broken);
    s.blobs.map.set(hash, broken);
    const x = await s.req("/files/a.png", { method: "PUT", headers: { "X-Blob": hash } });
    expect(x.status).toBe(400);
    const batch = await s.req("/batch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ops: [{ op: "attach", path: "b.png", blob: hash }] }),
    });
    expect(batch.status).toBe(400);

    // Import: the whole bundle is refused, naming the file.
    const tar = writeTar([
      { path: "a.md", bytes: new TextEncoder().encode("---\ntype: Note\n---\nHi\n") },
      { path: "pics/bad.jpg", bytes: sample("photo.jpg").subarray(0, 300) },
    ]);
    const imp = await s.req("/import", {
      method: "POST",
      headers: { "Content-Type": "application/x-tar" },
      body: tar as unknown as BodyInit,
    });
    expect(imp.status).toBe(400);
    expect(((await imp.json()) as { error: string }).error).toContain(
      "pics/bad.jpg is not a valid JPEG",
    );
    expect((await s.req("/files/a.md")).status).toBe(404);

    // An upload link.
    const call = await mcp(s);
    const m = await attachFile(s.app, call, "c.png", broken);
    expect(m.status).toBe(400);
    expect(m.text).toContain("bad_image");
  });

  test("X-Blob: bytes uploaded before take their type from the bytes", async () => {
    const s = setup();
    const png = makePng(5, 4);
    const hash = sha256Hex(png);
    s.blobs.map.set(hash, png);
    const r = await s.req("/files/p.gif", {
      method: "PUT",
      headers: { "X-Blob": hash, "Content-Type": "image/gif" },
    });
    expect(r.status).toBe(200);
    expect(await describeFile(s, "p.gif")).toMatchObject({ media: "image/png", width: 5 });
  });

  test("a changed type for the same bytes is a write, not a no-op (TEMPRA-105 §2)", async () => {
    const s = setup();
    const bytes = new TextEncoder().encode('{"a": 1}');
    type Res = { seq: number; hash: string; notices?: { code: string; message: string }[] };
    const first = (await (await put(s, "x.data", bytes, "text/csv")).json()) as Res;
    const match = { "If-Match": `"${first.hash}"` };
    const tsv = "text/tab-separated-values";
    const second = (await (await put(s, "x.data", bytes, tsv, match)).json()) as Res;
    expect(second.seq).toBeGreaterThan(first.seq);
    expect(second.hash).toBe(first.hash);
    expect(second.notices?.[0]).toMatchObject({ code: "media_changed" });
    expect(await describeFile(s, "x.data")).toMatchObject({ media: tsv, seq: second.seq });
    // The same bytes and type again change nothing.
    const third = (await (await put(s, "x.data", bytes, tsv, match)).json()) as Res;
    expect(third.seq).toBe(second.seq);
    expect(third.notices).toBeUndefined();
    const event = s.store().events({ since: first.seq }).events.at(0) as unknown as {
      meta: { media: unknown };
    };
    expect(event.meta.media).toEqual({ from: "text/csv", to: "text/tab-separated-values" });

    // An image stored under the wrong type before: the same bytes again put it right.
    const webp = sample("lossy.webp");
    const old = legacyAttach(s, "assets/miami.webp", webp, "image/jpeg");
    const fixed = (await (
      await put(s, "assets/miami.webp", webp, "image/webp", {
        "If-Match": `"${sha256Hex(webp)}"`,
      })
    ).json()) as Res;
    expect(fixed.seq).toBeGreaterThan(old.seq);
    expect(await describeFile(s, "assets/miami.webp")).toMatchObject({
      media: "image/webp",
      width: 40,
      height: 24,
    });
  });

  test("dimensions: backfilled on first read for attachments from before", async () => {
    const s = setup();
    legacyAttach(s, "old.png", makePng(7, 3), "image/png");
    const view = s.store().read("old.png");
    expect(view).not.toHaveProperty("width");
    expect(await describeFile(s, "old.png")).toMatchObject({ width: 7, height: 3 });
    expect(s.store().read("old.png")).toMatchObject({ width: 7, height: 3 });
    // One that does not decode is kept as unknown, so it is not read again.
    legacyAttach(s, "bad.png", truncatedIdatPng(), "image/png");
    expect(await describeFile(s, "bad.png")).toMatchObject({ width: null, height: null });
    expect(s.store().read("bad.png")).toMatchObject({ width: null, height: null });
  });

  test("dimensions through the links route, the export bundle and MCP read", async () => {
    const s = setup();
    await put(s, "pics/a.gif", sample("anim.gif"), "image/gif");
    const links = (await (await s.req("/links/pics/a.gif")).json()) as Record<string, unknown>;
    expect(links).toMatchObject({ media: "image/gif", width: 30, height: 18, inbound: [] });
    const bundle = s.store().exportBundle();
    expect(bundle.files.find((f) => f.path === "pics/a.gif")?.blob).toMatchObject({
      media: "image/gif",
      width: 30,
      height: 18,
    });
    const call = await mcp(s);
    expect((await call("read", { path: "pics/a.gif" })).text).toContain("dimensions: 30×18 px");
  });

  test("libraries from before get the columns once, and keep their attachments", () => {
    const db = new Database(":memory:");
    const store = new LibraryStore(bunSqlHandle(db));
    const bytes = makePng(2, 2);
    store.apply({ actor: "t/a", request_id: "r1" }, [
      {
        op: "attach",
        path: "a.png",
        blob: { hash: sha256Hex(bytes), size: bytes.length, media: "image/png" },
      },
    ]);
    db.run("ALTER TABLE blobs DROP COLUMN width");
    db.run("ALTER TABLE blobs DROP COLUMN height");
    db.run("DELETE FROM meta WHERE key = 'blob_dimensions'");
    const reopened = new LibraryStore(bunSqlHandle(db));
    const view = reopened.read("a.png");
    expect(view).toMatchObject({ kind: "attachment", media: "image/png" });
    expect(view).not.toHaveProperty("width");
    reopened.setDimensions(sha256Hex(bytes), 2, 2);
    expect(reopened.read("a.png")).toMatchObject({ width: 2, height: 2 });
  });
});

/** A page showing the given files as figures. */
const showing = (s: S, path: string, files: string[]) =>
  s.req(`/files/${path}`, {
    method: "PUT",
    headers: { "Content-Type": "text/markdown" },
    body: [
      "---",
      "type: Note",
      "title: Figures",
      "description: Figures.",
      "---",
      ...files.map((f) => `![${f}](/${f})\n`),
    ].join("\n"),
  });

/** An MP4 as clip.mp4 is, `moov` after its media data, with `pad` more bytes of media data. */
function paddedMp4(pad: number): Uint8Array {
  const b = sample("clip.mp4");
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const parts: Uint8Array[] = [];
  for (let at = 0; at < b.length; ) {
    const size = v.getUint32(at);
    const box = b.subarray(at, at + size);
    if (new TextDecoder().decode(box.subarray(4, 8)) === "mdat") {
      const grown = new Uint8Array(size + pad);
      grown.set(box);
      new DataView(grown.buffer).setUint32(0, size + pad);
      parts.push(grown);
    } else parts.push(box);
    at += size;
  }
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

describe("sizes worked out once from stored bytes (TEMPRA-183, TEMPRA-185)", () => {
  test("a stored image that does not decode is fetched from the blob store once", async () => {
    const s = setup();
    const bytes = truncatedIdatPng();
    const hash = sha256Hex(bytes);
    legacyAttach(s, "bad.png", bytes, "image/png");
    await showing(s, "uses.md", ["bad.png"]);
    const fetched = () => s.blobs.gets.filter((g) => g.hash === hash).length;
    expect(await describeFile(s, "bad.png")).toMatchObject({ width: null, height: null });
    expect(fetched()).toBe(1);
    // Read again: the attachment, the page showing it, its figures for an agent.
    expect(await describeFile(s, "bad.png")).toMatchObject({ width: null, height: null });
    const page = (await describeFile(s, "uses.md")) as { images: Record<string, unknown> };
    expect(page.images["bad.png"]).toMatchObject({ width: null, height: null });
    const call = await mcp(s);
    expect((await call("read", { path: "uses.md" })).text).toContain("/bad.png");
    expect(fetched()).toBe(1);
  });

  test("a video stored without its size gains it on first read, through ranged reads only", async () => {
    const s = setup();
    const webm = sample("clip.webm");
    const mp4 = paddedMp4(200 * 1024);
    legacyAttach(s, "clips/a.webm", webm, "video/webm");
    legacyAttach(s, "clips/b.mp4", mp4, "video/mp4");
    expect(s.store().read("clips/a.webm")).not.toHaveProperty("width");
    expect(await describeFile(s, "clips/a.webm")).toMatchObject({ width: 64, height: 36 });
    expect(s.store().read("clips/a.webm")).toMatchObject({ width: 64, height: 36 });
    // An MP4 whose moov comes after 200 KB of media data: found box by box, not read whole.
    await showing(s, "clips.md", ["clips/b.mp4"]);
    const page = (await describeFile(s, "clips.md")) as { images: Record<string, unknown> };
    const mp4Hash = sha256Hex(mp4);
    expect(page.images["clips/b.mp4"]).toMatchObject({ width: 48, height: 32 });
    expect(s.store().read("clips/b.mp4")).toMatchObject({ width: 48, height: 32 });
    const reads = s.blobs.gets.filter((g) => g.hash === mp4Hash || g.hash === sha256Hex(webm));
    expect(reads.length).toBeGreaterThan(0);
    expect(reads.every((g) => g.range !== undefined)).toBe(true);
    const read = reads
      .filter((g) => g.hash === mp4Hash)
      .reduce((n, g) => n + (g.range?.length ?? 0), 0);
    expect(read).toBeLessThan(mp4.length / 2);
    // Settled: read again, nothing more is fetched.
    const before = s.blobs.gets.length;
    await describeFile(s, "clips/b.mp4");
    await describeFile(s, "clips.md");
    expect(s.blobs.gets.length).toBe(before);
  });

  test("a video whose header does not parse is kept unsized and not read again", async () => {
    const s = setup();
    const cut = sample("clip.webm").subarray(0, 40);
    const hash = sha256Hex(cut);
    legacyAttach(s, "clips/cut.webm", cut, "video/webm");
    expect(await describeFile(s, "clips/cut.webm")).toMatchObject({ width: null, height: null });
    expect(await describeFile(s, "clips/cut.webm")).toMatchObject({ width: null, height: null });
    expect(s.blobs.gets.filter((g) => g.hash === hash)).toHaveLength(1);
  });
});

describe("a video and its poster name each other (TEMPRA-182)", () => {
  test("the video's JSON carries its poster, the poster's names its video", async () => {
    const s = setup();
    const webm = sample("clip.webm");
    const poster = makePng(64, 36);
    await put(s, "clips/demo.webm", webm, "video/webm");
    expect(await describeFile(s, "clips/demo.webm")).toMatchObject({
      poster: null,
      poster_for: null,
    });
    await put(s, "clips/demo.poster.png", poster, "image/png");
    expect(await describeFile(s, "clips/demo.webm")).toMatchObject({
      poster: {
        path: "clips/demo.poster.png",
        hash: sha256Hex(poster),
        media: "image/png",
        width: 64,
        height: 36,
      },
      poster_for: null,
    });
    expect(await describeFile(s, "clips/demo.poster.png")).toMatchObject({
      poster: null,
      poster_for: "clips/demo.webm",
    });
    // An image named like a poster with no video beside it is just an image.
    await put(s, "clips/lone.poster.png", poster, "image/png");
    expect(await describeFile(s, "clips/lone.poster.png")).toMatchObject({ poster_for: null });
    const call = await mcp(s);
    expect((await call("read", { path: "clips/demo.webm" })).text).toContain(
      "poster: /clips/demo.poster.png",
    );
    expect((await call("read", { path: "clips/demo.poster.png", image: false })).text).toContain(
      "poster for: /clips/demo.webm",
    );
  });
});

describe("exports name attachments by hash (TEMPRA-83)", () => {
  test("a nightly folder holds no bytes and downloads whole; a person's export streams them", async () => {
    const s = setup();
    const bytes = new Uint8Array(1500).map((_, i) => i % 251);
    legacyAttach(s, "files/data.bin", bytes, "application/octet-stream");
    const r = await s.app.request(`${API}/maintain`, {
      method: "POST",
      headers: { Origin: "http://localhost" },
    });
    expect(r.status).toBe(200);
    const key = ((await r.json()) as { export: string }).export;
    const stored = readTar(s.bucket.objects.get(`${key}bundle.tar`) as Uint8Array);
    expect(stored.map((f) => f.path)).not.toContain("files/data.bin");

    const date = key.split("/").at(-2);
    const dl = await s.app.request(`/owner/demo/-/exports/${date}/bundle.tar`);
    expect(dl.status).toBe(200);
    const whole = readTar(new Uint8Array(await dl.arrayBuffer()));
    expect(whole.find((f) => f.path === "files/data.bin")?.bytes).toEqual(bytes);
    // A nightly folder is the plain format: the files, with no index.md or log.md.
    expect(whole.map((f) => f.path)).not.toContain("log.md");

    const exp = await s.req("/export");
    expect(exp.status).toBe(200);
    const mine = readTar(new Uint8Array(await exp.arrayBuffer()));
    expect(mine.find((f) => f.path === "files/data.bin")?.bytes).toEqual(bytes);

    // Bytes gone: the person's export is a clear 500 before anything is sent.
    s.blobs.map.delete(sha256Hex(bytes));
    const gone = await s.req("/export");
    expect(gone.status).toBe(500);
    expect(await gone.text()).toContain("blob_missing");
  });
});
