import { describe, expect, test } from "bun:test";
import { mediaFor } from "../src/client";
import { checkAttachment, formatOf, imageInfo, sniffImage, videoSize } from "../src/media";
import { StoreError } from "../src/store/errors";
import { makePng, SAMPLES, SVG, sample, truncatedIdatPng } from "./images";

const refused = (bytes: Uint8Array, declared: string | null) => {
  try {
    checkAttachment(bytes, declared, "x");
  } catch (e) {
    if (e instanceof StoreError && e.code === "bad_image" && e.status === 400) return e.message;
    throw e;
  }
  return null;
};

describe("image checks (TEMPRA-152)", () => {
  for (const s of SAMPLES) {
    test(`${s.file}: its type and size from its bytes`, () => {
      const bytes = sample(s.file);
      expect(imageInfo(bytes)).toMatchObject({ ok: true, width: s.width, height: s.height });
      expect(checkAttachment(bytes, s.media)).toEqual({
        media: s.media,
        width: s.width,
        height: s.height,
      });
    });

    test(`${s.file}: refused when cut short anywhere`, () => {
      const bytes = sample(s.file);
      for (let n = 0; n < bytes.length; n++) {
        const cut = bytes.subarray(0, n);
        const declared = refused(cut, s.media);
        if (declared === null) throw new Error(`${s.file} cut at ${n} of ${bytes.length} passed`);
        // Without a declared type, bytes that still carry the signature are checked as well.
        if (sniffImage(cut)) expect(refused(cut, null)).not.toBeNull();
      }
    });
  }

  test("SVG: the root and namespace, its size, refused when cut short", () => {
    expect(checkAttachment(SVG, "image/svg+xml")).toEqual({
      media: "image/svg+xml",
      width: 120,
      height: 60,
    });
    for (let n = 0; n < SVG.length; n++) {
      if (refused(SVG.subarray(0, n), "image/svg+xml") === null) {
        throw new Error(`SVG cut at ${n} passed`);
      }
    }
    const enc = (s: string) => new TextEncoder().encode(s);
    // A viewBox alone gives the size; no size at all is still an SVG.
    expect(
      checkAttachment(enc('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 30.4 10"/>'), null),
    ).toEqual({ media: "image/svg+xml", width: 30, height: 10 });
    expect(
      checkAttachment(enc("<svg xmlns='http://www.w3.org/2000/svg'><g/></svg>\n"), "image/svg+xml"),
    ).toEqual({ media: "image/svg+xml" });
    // Relative units say nothing about pixels: the viewBox wins.
    expect(
      checkAttachment(
        enc(
          '<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="2em" viewBox="0 0 8 4"></svg>',
        ),
        null,
      ),
    ).toEqual({ media: "image/svg+xml", width: 8, height: 4 });
    // Without the namespace no browser draws it as an image.
    expect(refused(enc("<svg><rect/></svg>"), "image/svg+xml")).toContain("xmlns");
    expect(refused(enc("<html><svg/></html>"), "image/svg+xml")).toContain("root element");
    // Text that is not an SVG keeps the type it was given.
    expect(checkAttachment(enc("<svg><rect/></svg>"), "text/plain")).toEqual({
      media: "text/plain",
    });
  });

  test("the type comes from the bytes, with a note when the declared one disagrees", () => {
    const png = sample("photo.png");
    const r = checkAttachment(png, "image/jpeg", "a/pic.jpg");
    expect(r).toMatchObject({ media: "image/png", width: 40, height: 24 });
    expect(r.note).toContain("image/jpeg was ignored");
    expect(checkAttachment(sample("lossy.webp"), "application/pdf").media).toBe("image/webp");
    // No declared type: an image is still found.
    expect(checkAttachment(sample("anim.gif"), null)).toMatchObject({ media: "image/gif" });
    expect(checkAttachment(sample("anim.gif"), null).note).toBeUndefined();
    // Other bytes keep what they were given.
    expect(checkAttachment(new Uint8Array([1, 2, 3]), "application/x-thing")).toEqual({
      media: "application/x-thing",
    });
    expect(checkAttachment(new Uint8Array([1, 2, 3]), null)).toEqual({ media: null });
  });

  test("bytes declared as an image that are not one are refused, naming why", () => {
    const text = new TextEncoder().encode("hello, not a picture");
    expect(refused(text, "image/png")).toBe(
      "x is not a valid PNG: it does not start with a PNG signature.",
    );
    expect(refused(text, "image/jpg")).toContain("JPEG");
    expect(refused(new Uint8Array(0), "image/webp")).toContain("WebP");
    // An image type this module does not check passes as declared.
    expect(checkAttachment(text, "image/x-icon")).toEqual({ media: "image/x-icon" });
  });

  test("TEMPRA-105: an IDAT that runs past the end, or a bad checksum, is refused", () => {
    expect(refused(truncatedIdatPng(), "image/png")).toMatch(/IDAT chunk declares \d+ bytes/);
    const png = makePng(16, 16, { noise: true });
    const flipped = png.slice();
    flipped[60] = (flipped[60] as number) ^ 0xff;
    expect(refused(flipped, "image/png")).toContain("checksum");
    // Trailing bytes after IEND are tolerated, as browsers tolerate them.
    const trailing = new Uint8Array(png.length + 4);
    trailing.set(png);
    expect(checkAttachment(trailing, "image/png")).toMatchObject({ width: 16, height: 16 });
  });

  test("a JPEG without a frame header or without image data is refused", () => {
    const soiEoi = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
    expect(refused(soiEoi, "image/jpeg")).toContain("SOF");
    const gifNoImage = new TextEncoder().encode("GIF89a\x01\x00\x01\x00\x00\x00\x00;");
    expect(refused(gifNoImage, "image/gif")).toContain("no image");
  });

  test("media types: the new kinds by extension, and the image names", () => {
    for (const [ext, media] of [
      ["webp", "image/webp"],
      ["avif", "image/avif"],
      ["mp4", "video/mp4"],
      ["webm", "video/webm"],
      ["mp3", "audio/mpeg"],
      ["ogg", "audio/ogg"],
      ["wav", "audio/wav"],
    ]) {
      expect(mediaFor(`a/b.${ext}`)).toBe(media as string);
    }
    expect(formatOf("image/jpg")).toBe("jpeg");
    expect(formatOf("IMAGE/PNG; charset=x")).toBe("png");
    expect(formatOf("video/mp4")).toBeNull();
  });

  test("a few-hundred-KB image checks quickly", () => {
    const big = makePng(320, 320, { noise: true });
    expect(big.length).toBeGreaterThan(250_000);
    const t = performance.now();
    expect(checkAttachment(big, "image/png")).toMatchObject({ width: 320, height: 320 });
    expect(performance.now() - t).toBeLessThan(200);
  });
});

describe("video, audio and PDF (TEMPRA-164)", () => {
  const PDF = new TextEncoder().encode("%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\n%%EOF\n");
  const WAV = new TextEncoder().encode("RIFF\x24\0\0\0WAVEfmt \x10\0\0\0\x01\0\x01\0");

  test("their type comes from their bytes, with a video's frame size", () => {
    expect(checkAttachment(sample("clip.webm"), "video/webm")).toEqual({
      media: "video/webm",
      width: 64,
      height: 36,
    });
    expect(checkAttachment(sample("clip.mp4"), null)).toEqual({
      media: "video/mp4",
      width: 48,
      height: 32,
    });
    expect(checkAttachment(sample("tone.ogg"), "application/octet-stream")).toEqual({
      media: "audio/ogg",
    });
    expect(checkAttachment(PDF, "application/pdf")).toEqual({ media: "application/pdf" });
    expect(checkAttachment(WAV, "audio/x-wav")).toEqual({ media: "audio/wav" });
  });

  test("a declared type that disagrees is ignored, with a note; audio in a video container stays", () => {
    const pdf = checkAttachment(PDF, "image/png");
    expect(pdf.media).toBe("application/pdf");
    expect(pdf.note).toContain("declared image/png was ignored");
    expect(checkAttachment(sample("clip.webm"), "text/plain").note).toContain("WebM");
    expect(checkAttachment(sample("clip.mp4"), "audio/mp4").media).toBe("audio/mp4");
    expect(checkAttachment(sample("clip.webm"), "audio/webm").media).toBe("audio/webm");
  });

  test("bytes with no signature keep the declared type; a broken header has no size", () => {
    const bin = new Uint8Array([1, 2, 3, 4]);
    expect(checkAttachment(bin, "video/mp4")).toEqual({ media: "video/mp4" });
    const cut = sample("clip.webm").subarray(0, 40);
    expect(checkAttachment(cut, "video/webm")).toEqual({ media: "video/webm" });
    expect(videoSize(sample("clip.mp4").subarray(0, 30), "video/mp4")).toBeNull();
  });
});
