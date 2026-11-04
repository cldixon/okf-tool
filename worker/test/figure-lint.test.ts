import { describe, expect, test } from "bun:test";
import { IMAGE_MAX_BYTES, IMAGE_MAX_EDGE } from "../src/format/images";
import type { LintWarning } from "../src/format/types";
import { LibraryStore, type RequestContext } from "../src/store/store";
import { bunSqlHandle } from "./sqlite";

let n = 0;
const ctx = (): RequestContext => ({
  actor: "claude-code/ana",
  request_id: `req-${++n}`,
  by: { person: "u_ana", agent: "a_ana" },
});

const md = (body: string) =>
  `---\ntype: Design\ntitle: Page\ndescription: A page.\nstatus: draft\n---\n# Page\n\n${body}\n`;

const figure = (lint: LintWarning[]) =>
  lint.filter((l) => l.code.startsWith("image_")).map((l) => l.code);

const blob = (c: string, size = 100, media: string | null = "image/png", w = 800, h = 600) => ({
  hash: c.repeat(64),
  size,
  media,
  width: w,
  height: h,
});

function store() {
  let t = Date.parse("2026-10-25T12:00:00Z");
  return new LibraryStore(bunSqlHandle(), {
    now: () => {
      t += 1000;
      return new Date(t);
    },
  });
}

function write(s: LibraryStore, path: string, body: string) {
  const if_match = s.pages().items.find((i) => i.path === path)?.hash ?? null;
  return (
    s.apply(ctx(), [{ op: "write", path, content: md(body), if_match }]).results[0]?.lint ?? []
  );
}

function hashOf(s: LibraryStore, path: string): string | null {
  try {
    const v = s.read(path);
    return "hash" in v ? v.hash : null;
  } catch {
    return null;
  }
}

function attach(s: LibraryStore, path: string, b: ReturnType<typeof blob>) {
  const if_match = hashOf(s, path);
  return s.apply(ctx(), [{ op: "attach", path, blob: b, if_match }]);
}

/** The figure lint stored with a page, as `read` returns it. */
function stored(s: LibraryStore, path: string) {
  const v = s.read(path);
  return v.kind === "page" ? figure(v.lint) : [];
}

/** The figure lint in the page's `work` item. */
function work(s: LibraryStore, path: string) {
  const item = s.work({ kind: "lint" }).items.find((i) => i.path === path);
  return item?.detail ?? "";
}

describe("figure lint (TEMPRA-159)", () => {
  test("image_no_alt on write, in work, cleared by the fix", () => {
    const s = store();
    attach(s, "a/chart.png", blob("a"));
    const lint = write(s, "a/page.md", "![](/a/chart.png)");
    expect(figure(lint)).toEqual(["image_no_alt"]);
    expect(lint[0]?.target).toBe("/a/chart.png");
    expect(lint.find((l) => l.code === "image_no_alt")?.message).toContain("alt text");
    expect(stored(s, "a/page.md")).toEqual(["image_no_alt"]);
    expect(work(s, "a/page.md")).toContain("no alt text");
    expect(figure(write(s, "a/page.md", "![A bar chart of margin](/a/chart.png)"))).toEqual([]);
    expect(stored(s, "a/page.md")).toEqual([]);
    expect(work(s, "a/page.md")).toBe("");
  });

  test("image_no_alt through a reference definition", () => {
    const s = store();
    attach(s, "a/chart.png", blob("a"));
    expect(figure(write(s, "a/page.md", "![][c]\n\n[c]: /a/chart.png"))).toEqual(["image_no_alt"]);
  });

  test("image_external names attach with source_url and sources; cleared by attaching", () => {
    const s = store();
    const lint = write(s, "a/page.md", "![A logo](https://example.com/logo.png)");
    expect(figure(lint)).toEqual(["image_external"]);
    const w = lint.find((l) => l.code === "image_external");
    expect(w?.target).toBe("https://example.com/logo.png");
    expect(w?.message).toContain("example.com");
    expect(w?.message).toContain("`attach`");
    expect(w?.message).toContain('`source_url: "https://example.com/logo.png"`');
    expect(w?.message).toContain("the server fetches it");
    expect(w?.message).toContain("`sources`");
    expect(work(s, "a/page.md")).toBe("");
    expect(s.work({ kind: "external_image" }).items[0]?.detail).toContain("hotlinked");
    // A link to another site is not an image.
    expect(figure(write(s, "a/page.md", "[A logo](https://example.com/logo.png)"))).toEqual([]);
    attach(s, "a/logo.png", blob("b"));
    expect(figure(write(s, "a/page.md", "![A logo](/a/logo.png)"))).toEqual([]);
  });

  test("image_large by bytes or by the long edge; cleared by a smaller version", () => {
    const s = store();
    attach(s, "a/big.png", blob("a", IMAGE_MAX_BYTES + 1));
    attach(s, "a/wide.png", blob("b", 100, "image/png", IMAGE_MAX_EDGE + 1, 200));
    attach(s, "a/ok.png", blob("c", IMAGE_MAX_BYTES, "image/png", IMAGE_MAX_EDGE, IMAGE_MAX_EDGE));
    const lint = write(s, "a/page.md", "![Big](/a/big.png) ![Wide](/a/wide.png) ![Ok](/a/ok.png)");
    expect(figure(lint)).toEqual(["image_large", "image_large"]);
    expect(lint.map((l) => l.target)).toContain("a/big.png");
    expect(lint.find((l) => l.target === "a/wide.png")?.message).toContain("4001 × 200 px");
    expect(stored(s, "a/page.md")).toEqual(["image_large", "image_large"]);
    expect(work(s, "a/page.md")).toContain("make a smaller one with `transform`");
    // A link (not an image) to a large file is fine.
    expect(figure(write(s, "a/page.md", "[Big](/a/big.png)"))).toEqual([]);
  });

  test("image_not_image for a file that cannot be drawn; video, audio and PDF are fine", () => {
    const s = store();
    attach(s, "a/data.csv", blob("a", 100, "text/csv", 0, 0));
    attach(s, "a/clip.mp4", blob("b", 100, "video/mp4"));
    attach(s, "a/song.mp3", blob("c", 100, "audio/mpeg", 0, 0));
    attach(s, "a/paper.pdf", blob("d", 100, "application/pdf", 0, 0));
    const lint = write(
      s,
      "a/page.md",
      "![Data](/a/data.csv) ![Clip](/a/clip.mp4) ![Song](/a/song.mp3) ![Paper](/a/paper.pdf)",
    );
    expect(figure(lint)).toEqual(["image_not_image"]);
    expect(lint.find((l) => l.code === "image_not_image")?.message).toContain("text/csv");
    expect(figure(write(s, "a/page.md", "[Data](/a/data.csv)"))).toEqual([]);
    expect(stored(s, "a/page.md")).toEqual([]);
    // A video, audio file or PDF is not an image: its size is never image_large (TEMPRA-164).
    attach(s, "a/long.webm", blob("e", IMAGE_MAX_BYTES * 3, "video/webm", 5000, 3000));
    attach(s, "a/book.pdf", blob("f", IMAGE_MAX_BYTES * 3, "application/pdf", 0, 0));
    expect(figure(write(s, "a/page.md", "![Long](/a/long.webm) ![Book](/a/book.pdf)"))).toEqual([]);
  });

  test("recomputed when an attachment is replaced, retyped or deleted", () => {
    const s = store();
    attach(s, "a/chart.png", blob("a"));
    write(s, "a/page.md", "![Chart](/a/chart.png)");
    expect(stored(s, "a/page.md")).toEqual([]);

    attach(s, "a/chart.png", blob("b", IMAGE_MAX_BYTES * 2));
    expect(stored(s, "a/page.md")).toEqual(["image_large"]);
    expect(work(s, "a/page.md")).toContain("/a/chart.png");

    attach(s, "a/chart.png", blob("c"));
    expect(stored(s, "a/page.md")).toEqual([]);
    expect(work(s, "a/page.md")).toBe("");

    // The same bytes with a new type (TEMPRA-105 §2).
    attach(s, "a/chart.png", blob("c", 100, "application/zip"));
    expect(stored(s, "a/page.md")).toEqual(["image_not_image"]);

    attach(s, "a/chart.png", blob("c", 100, "image/png"));
    expect(stored(s, "a/page.md")).toEqual([]);

    attach(s, "a/chart.png", blob("d", IMAGE_MAX_BYTES * 2));
    expect(stored(s, "a/page.md")).toEqual(["image_large"]);
    s.apply(ctx(), [{ op: "delete", path: "a/chart.png", if_match: hashOf(s, "a/chart.png") }]);
    // Deleted: a broken link now, no longer a large image.
    const v = s.read("a/page.md");
    expect(v.kind === "page" && v.lint.map((l) => l.code)).toEqual(["broken_link"]);
  });

  test("an attachment added after the page that shows it", () => {
    const s = store();
    write(s, "a/page.md", "![Chart](/a/chart.png)");
    attach(s, "a/chart.png", blob("a", IMAGE_MAX_BYTES + 1));
    expect(stored(s, "a/page.md")).toEqual(["image_large"]);
  });

  test("a size learned on read can make a figure large", () => {
    const s = store();
    attach(s, "a/old.png", { hash: "e".repeat(64), size: 100, media: "image/png" } as never);
    write(s, "a/page.md", "![Old](/a/old.png)");
    expect(stored(s, "a/page.md")).toEqual([]);
    s.setDimensions("e".repeat(64), 6000, 3000);
    expect(stored(s, "a/page.md")).toEqual(["image_large"]);
  });

  test("import lints too, whatever the order of the files", () => {
    const s = store();
    const res = s.import(ctx(), [
      {
        path: "a/page.md",
        markdown: md("![](/a/data.csv) ![Big](/a/big.png) ![x](http://h.io/x.png)"),
      },
      { path: "a/data.csv", blob: blob("a", 100, "text/csv", 0, 0) },
      { path: "a/big.png", blob: blob("b", IMAGE_MAX_BYTES + 1) },
    ]);
    const codes = res.warnings.flatMap((w) => figure(w.lint)).sort();
    expect(codes).toEqual(["image_external", "image_large", "image_no_alt", "image_not_image"]);
    expect(stored(s, "a/page.md").sort()).toEqual([
      "image_external",
      "image_large",
      "image_no_alt",
      "image_not_image",
    ]);
  });

  test("none refuses a write", () => {
    const s = store();
    attach(s, "a/data.csv", blob("a", 100, "text/csv", 0, 0));
    const res = s.apply(ctx(), [
      { op: "write", path: "a/page.md", content: md("![](https://x.io/a.png) ![](/a/data.csv)") },
    ]);
    expect(res.results[0]?.hash).not.toBeNull();
  });
});

describe("external_image work (TEMPRA-163)", () => {
  test("one item per page with its count, never under lint too; gone once brought home", () => {
    const s = store();
    write(
      s,
      "a/page.md",
      "![A](https://a.io/1.png) ![B](https://b.io/2.png) ![A again](https://a.io/1.png) ![](/a/x.png)",
    );
    write(s, "a/other.md", "![C](//c.io/3.png)");
    const w = s.work({ kind: "external_image" });
    expect(w.items.map((i) => i.path).sort()).toEqual(["a/other.md", "a/page.md"]);
    expect(w.counts).toEqual({ external_image: 2 });
    const page = w.items.find((i) => i.path === "a/page.md");
    expect(page?.kind).toBe("external_image");
    expect(page?.detail).toBe(
      "2 images hotlinked from another site: https://a.io/1.png, https://b.io/2.png",
    );
    for (const word of ["`attach`", "`source_url`", "`edit`", "`sources`"]) {
      expect(page?.suggested_action).toContain(word);
    }
    expect(w.items.find((i) => i.path === "a/other.md")?.detail).toBe(
      "1 image hotlinked from another site: //c.io/3.png",
    );
    // The page's other lint stays a lint item, without the hotlinks.
    const lint = s.work({ kind: "lint" }).items.find((i) => i.path === "a/page.md");
    expect(lint?.detail).toContain("no alt text");
    expect(lint?.detail).not.toContain("hotlinked");
    // The stored lint keeps the code (read and the write result report it).
    expect(stored(s, "a/page.md")).toContain("image_external");
    // Counted in the whole queue and the health summary.
    expect(s.work().counts.external_image).toBe(2);
    expect(s.health().counts.external_image).toBe(2);
    attach(s, "a/c.png", blob("c"));
    write(s, "a/other.md", "![C](/a/c.png)");
    expect(s.work({ kind: "external_image" }).items.map((i) => i.path)).toEqual(["a/page.md"]);
    expect(s.work({ path: "a/other.md" }).items.map((i) => i.kind)).not.toContain("external_image");
  });

  test("a library linted before moves its hotlinks out of lint once", () => {
    const sql = bunSqlHandle();
    let t = Date.parse("2026-10-25T12:00:00Z");
    const now = () => {
      t += 1000;
      return new Date(t);
    };
    const s = new LibraryStore(sql, { now });
    write(s, "a/page.md", "![](https://a.io/1.png)");
    // As TEMPRA-159 left it: every lint but broken links in the lint flag.
    const stored = sql.all<{ page_id: string; lint: string }>("SELECT page_id, lint FROM pages")[0];
    sql.run("DELETE FROM flags WHERE kind = 'external_image'");
    sql.run(
      "UPDATE flags SET detail = ? WHERE kind = 'lint' AND page_id = ?",
      stored?.lint ?? "[]",
      stored?.page_id ?? "",
    );
    sql.run("DELETE FROM meta WHERE key = 'external_image_flags'");
    expect(s.work({ kind: "lint" }).items[0]?.detail).toContain("hotlinked");
    const again = new LibraryStore(sql, { now });
    expect(again.work({ kind: "external_image" }).items.map((i) => i.path)).toEqual(["a/page.md"]);
    const left = again.work({ kind: "lint" }).items[0]?.detail ?? "";
    expect(left).toContain("no alt text");
    expect(left).not.toContain("hotlinked");
  });
});
