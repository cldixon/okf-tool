/**
 * MCP `transform` (TEMPRA-208; tempra-dev: app/media, How agents add): an attachment changed on
 * the server through the Images binding (a double here) or, for a video's poster, a frame from the
 * render Worker; the result an ordinary write, made from the original at its hash.
 */
import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { type ImageTransform, imagesService } from "../src/images";
import { type PosterFrame, RENDER_UNAVAILABLE, servicePoster } from "../src/render";
import { setup } from "./harness";
import { makePng, sample } from "./images";
import { attachFile } from "./upload";

type S = ReturnType<typeof setup>;

async function connect(app: S["app"]) {
  const transport = new StreamableHTTPClientTransport(new URL("http://localhost/mcp"), {
    requestInit: { headers: { Authorization: "Bearer writer" } },
    fetch: async (url, init) => app.request(url.toString(), init as RequestInit),
  });
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(transport);
  return async (name: string, args: Record<string, unknown> = {}) => {
    const r = await client.callTool({ name, arguments: args });
    return {
      text: (r.content as { text: string }[]).map((c) => c.text).join("\n"),
      isError: !!r.isError,
    };
  };
}

/** An Images double that answers a real PNG of the size the transform asks for. */
function fakeImages(s: S, size: { width: number; height: number }) {
  const calls: { t: ImageTransform; format: string }[] = [];
  s.deps.images = imagesService({
    blobs: s.blobs,
    transformer: {
      input: (stream) => ({
        transform: (t) => ({
          output: async (o) => {
            await new Response(stream).arrayBuffer();
            calls.push({ t, format: o.format });
            let w = t.trim?.width ?? size.width;
            let h = t.trim?.height ?? size.height;
            if (t.width && t.height) {
              const k = Math.min(1, t.width / Math.max(w, h));
              w = Math.round(w * k);
              h = Math.round(h * k);
            }
            return {
              image: () => new Response(makePng(w, h)).body as ReadableStream<Uint8Array>,
              contentType: () => "image/png",
            };
          },
        }),
      }),
    },
  });
  return calls;
}

const fileJson = async (s: S, path: string) =>
  (await (await s.req(`/files/${path}`, { headers: { Accept: "application/json" } })).json()) as {
    hash: string;
    width: number;
    height: number;
    credit: string | null;
    made_from: { path: string; hash: string; op: string } | null;
  };

describe("transform (TEMPRA-208)", () => {
  test("resize in place needs if_match; the result is made from the original, its credit kept", async () => {
    const s = setup();
    const calls = fakeImages(s, { width: 200, height: 100 });
    const call = await connect(s.app);
    await attachFile(s.app, call, "figs/big.png", makePng(200, 100), { credit: "Ann" });
    const before = await fileJson(s, "figs/big.png");
    const bare = await call("transform", { path: "figs/big.png", op: "resize", edge: 50 });
    expect(bare.text).toContain("if_match_required");
    const r = await call("transform", {
      path: "figs/big.png",
      op: "resize",
      edge: 50,
      if_match: before.hash,
      note: "Smaller.",
    });
    expect(r.isError).toBe(false);
    expect(r.text).toContain("Made /figs/big.png from /figs/big.png (resize 50): 50×25");
    expect(calls[0]?.t).toEqual({ width: 50, height: 50, fit: "scale-down" });
    const after = await fileJson(s, "figs/big.png");
    expect(after).toMatchObject({ width: 50, height: 25, credit: "Ann" });
    expect(after.made_from).toEqual({ path: "figs/big.png", hash: before.hash, op: "resize 50" });
    expect((await call("read", { path: "figs/big.png", image: false })).text).toContain(
      "made from: /figs/big.png (resize 50;",
    );
  });

  test("crop within the image, convert and thumbnail beside it", async () => {
    const s = setup();
    const calls = fakeImages(s, { width: 200, height: 100 });
    const call = await connect(s.app);
    await attachFile(s.app, call, "figs/shot.png", makePng(200, 100));
    const crop = await call("transform", {
      path: "figs/shot.png",
      op: "crop",
      box: { x: 10, y: 20, width: 80, height: 40 },
      to: "figs/shot-detail.png",
    });
    expect(crop.isError).toBe(false);
    expect(calls.at(-1)?.t).toEqual({ trim: { top: 20, left: 10, width: 80, height: 40 } });
    expect((await fileJson(s, "figs/shot-detail.png")).width).toBe(80);
    const over = await call("transform", {
      path: "figs/shot.png",
      op: "crop",
      box: { x: 150, y: 0, width: 80, height: 40 },
      to: "figs/x.png",
    });
    expect(over.text).toContain("The box runs past the image, which is 200×100.");
    await call("transform", { path: "figs/shot.png", op: "convert", format: "jpeg" });
    expect(calls.at(-1)?.format).toBe("image/jpeg");
    expect((await fileJson(s, "figs/shot.jpg")).made_from?.op).toBe("convert jpeg");
    await call("transform", { path: "figs/shot.png", op: "thumbnail" });
    // Smaller than the default 320 already: never enlarged.
    expect((await fileJson(s, "figs/shot.thumb.png")).width).toBe(200);
  });

  test("refusals: not an image, no binding, a page", async () => {
    const s = setup();
    const call = await connect(s.app);
    await attachFile(s.app, call, "data/rows.csv", new TextEncoder().encode("a,b\n1,2\n"));
    expect(
      (await call("transform", { path: "data/rows.csv", op: "convert", format: "png" })).text,
    ).toContain("not_an_image");
    await attachFile(s.app, call, "figs/a.png", makePng(4, 3));
    s.deps.images = imagesService({ blobs: s.blobs });
    expect(
      (await call("transform", { path: "figs/a.png", op: "convert", format: "webp" })).text,
    ).toContain("transform_unavailable");
    expect((await call("transform", { path: "a.md", op: "resize", edge: 100 })).text).toContain(
      "bad_path",
    );
  });

  test("a video's poster: a frame from the render Worker, beside it as x.poster.png", async () => {
    const s = setup();
    const asked: { url: string; time: number }[] = [];
    const poster: PosterFrame = async (req) => {
      asked.push(req);
      return { png: makePng(64, 36), width: 64, height: 36 };
    };
    s.deps.posterFrame = poster;
    const call = await connect(s.app);
    await attachFile(s.app, call, "clips/demo.webm", sample("clip.webm"));
    const r = await call("transform", { path: "clips/demo.webm", op: "poster", time: 1.5 });
    expect(r.isError).toBe(false);
    expect(asked[0]?.time).toBe(1.5);
    expect(asked[0]?.url).toContain("/dl/");
    // The signed URL opens the video itself.
    const got = await s.app.request(asked[0]?.url as string);
    expect(got.status).toBe(200);
    const made = await fileJson(s, "clips/demo.poster.png");
    expect(made).toMatchObject({ width: 64, height: 36 });
    expect(made.made_from?.op).toBe("poster 1.5s");
    s.deps.posterFrame = async () => ({
      error: "the video could not be read or decoded by the browser",
    });
    const bad = await call("transform", {
      path: "clips/demo.webm",
      op: "poster",
      to: "clips/p2.png",
    });
    expect(bad.text).toContain("No poster for /clips/demo.webm: the video could not be read");
    expect(
      (await call("transform", { path: "clips/demo.poster.png", op: "poster", to: "x.png" })).text,
    ).toContain("not_a_video");
  });

  test("the poster client: unavailable without the binding, metered, never a throw", async () => {
    expect(
      await servicePoster(undefined)({ url: "https://x/v", time: 0 }, { account: "a" }),
    ).toEqual({
      error: RENDER_UNAVAILABLE,
    });
    const metered: unknown[] = [];
    const ok = servicePoster(
      {
        render: async () => ({}),
        poster: async () => ({ png: new Uint8Array(5), width: 1, height: 1 }),
      },
      (e) => metered.push(e),
    );
    expect(await ok({ url: "https://x/v", time: 2 }, { account: "a", library: "l" })).toMatchObject(
      {
        width: 1,
      },
    );
    expect(metered).toEqual([{ kind: "render", account: "a", library: "l", bytes: 5 }]);
    const throwing = servicePoster({
      render: async () => ({}),
      poster: async () => {
        throw new Error("binding broke");
      },
    });
    expect(await throwing({ url: "https://x/v", time: 0 }, { account: "a" })).toEqual({
      error: RENDER_UNAVAILABLE,
    });
  });
});
