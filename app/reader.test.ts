import { afterEach, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  ATOM,
  type Doc,
  type DocNode,
  docText,
  fenceTitle,
  idOf,
  locate,
  parseMarkdown,
  reconcile,
  selectorAt,
  walk,
  wordDiff,
} from "@tempra/editor";
import {
  type Component,
  createRawSnippet,
  flushSync,
  mount as mountComponent,
  unmount,
} from "svelte";
import { SvelteMap } from "svelte/reactivity";
import { attachmentSource, type ImageRef, imageSource } from "./src/images";
import Reader from "./src/Reader.svelte";
import Body from "./src/reader/Body.svelte";
import { offsetAt, pointAt, rangeOf, readText, textblocks } from "./src/reader/dom";
import Lightbox from "./src/reader/Lightbox.svelte";
import type { FigureView } from "./src/reader/lightbox";
import Note from "./src/reader/Note.svelte";
import { openFigureContext } from "./src/reader/open-figure";
import { type BodyOptions, prepare } from "./src/reader/prepare";
import { blockMarks, type Highlight, hoveredOf, placeMark } from "./src/reader/reading";
import { Urls } from "./src/urls";

const FIXTURES = join(import.meta.dir, "..", "fixtures");

/** Every page body in Google's sample bundles, frontmatter removed. */
function bodies(): { file: string; body: string }[] {
  const all = (d: string): string[] =>
    readdirSync(d).flatMap((f) => {
      const p = join(d, f);
      return statSync(p).isDirectory() ? all(p) : p.endsWith(".md") ? [p] : [];
    });
  return all(FIXTURES)
    .filter((f) => !/(^|\/)(index|log|README|LICENSE)\.md$/.test(f))
    .map((file) => ({
      file: file.slice(FIXTURES.length + 1),
      body: readFileSync(file, "utf8").replace(/^---\n[\s\S]*?\n---\n?/, ""),
    }));
}

const stored = (md: string): Doc => reconcile(null, parseMarkdown(md));

/** What is mounted in a test, unmounted after it. */
const mounted: (() => void)[] = [];
afterEach(() => {
  for (const done of mounted.splice(0)) done();
});

/**
 * A component mounted into the page's DOM and flushed, as the app mounts it; `open` provides the
 * full-screen view's opener to the figures inside, as the reader does.
 */
// biome-ignore lint/suspicious/noExplicitAny: any component.
function put<P extends Record<string, any>>(c: Component<P>, props: P, open?: (n: number) => void) {
  const host = document.createElement("div");
  document.body.append(host);
  const instance = mountComponent(c, {
    target: host,
    props,
    context: open ? openFigureContext(open) : undefined,
  });
  flushSync();
  let gone = false;
  const done = () => {
    if (gone) return;
    gone = true;
    unmount(instance);
    host.remove();
  };
  mounted.push(done);
  return { host, root: { unmount: done } };
}

/** The markup a host holds, without the comment nodes Svelte anchors its blocks with. */
const markup = (el: Element) => el.innerHTML.replace(/<!--[\s\S]*?-->/g, "");

/** A body drawn by the reader into a DOM, as the app draws it. */
function draw(tree: Doc, options: BodyOptions = {}, older?: Doc) {
  const p = prepare(tree, options);
  const diff = older ? wordDiff(docText(older), p.text) : null;
  const { host } = put(Body, { prepared: p, diff, hideFirst: false });
  return { p, html: markup(host), root: host as Element, diff };
}

/** The blocks of a tree that carry IDs, outside footnote definitions (drawn beside the body). */
function blockIds(tree: Doc): string[] {
  const ids: string[] = [];
  walk(tree, (n: DocNode) => {
    if (n.type === "footnoteDefinition") return false;
    const id = idOf(n);
    if (id !== undefined && n.type !== "root") ids.push(id);
    return undefined;
  });
  return ids;
}

/**
 * The reader's counting, checked over one body: every textblock drawn once at its offset and
 * reading as the document's text, every block ID once, offsets through DOM points and back, and
 * selections to the quotes anchors store. A drawn diagram's text is not in the DOM (it is opaque),
 * so its block is left out.
 */
function counts(file: string, tree: Doc, options: BodyOptions = {}) {
  const { p, root } = draw(tree, options);
  const text = p.text;
  const drawn = new Set(
    p.figures.flatMap((f) => (f.kind === "diagram" ? [idOf(f.node) ?? ""] : [])),
  );
  const blocks = text.blocks.filter((b) => !(b.block !== null && drawn.has(b.block)));
  // Every textblock is drawn once, at its offset, reading exactly as the document's text.
  const tbs = textblocks(root);
  expect(tbs.length).toBe(blocks.length);
  tbs.forEach((tb, i) => {
    const b = blocks[i];
    expect({ file, i, at: Number(tb.getAttribute("data-text")) }).toEqual({
      file,
      i,
      at: b?.from ?? -1,
    });
    expect(readText(tb)).toBe(text.text.slice(b?.from, b?.to));
  });
  // Every block with an ID carries it, once.
  for (const id of blockIds(tree)) {
    expect(root.querySelectorAll(`[data-block="${id}"]`).length).toBe(1);
  }
  // Offsets survive the trip to a DOM point and back, at the start, middle and end of each
  // textblock, before and after every atom.
  for (const b of blocks) {
    const atoms = [...text.text.slice(b.from, b.to)].flatMap((ch, k) =>
      ch === ATOM ? [b.from + k, b.from + k + 1] : [],
    );
    for (const at of [b.from, Math.floor((b.from + b.to) / 2), b.to, ...atoms]) {
      const point = pointAt(root, at);
      expect(point).not.toBeNull();
      if (!point) continue;
      expect({ file, at: offsetAt(root, point.node, point.offset, false) }).toEqual({
        file,
        at,
      });
    }
  }
  // A selection inside each longer textblock maps to the quote an anchor stores.
  for (const b of blocks.filter((x) => x.to - x.from > 4)) {
    const range = rangeOf(root, b.from + 1, b.to - 1);
    expect(range).not.toBeNull();
    if (!range) continue;
    const from = offsetAt(root, range.startContainer, range.startOffset, false);
    const to = offsetAt(root, range.endContainer, range.endOffset, true);
    expect({ file, from, to }).toEqual({ file, from: b.from + 1, to: b.to - 1 });
    // …and the stored selector made from it finds the same text again, repeated table cells
    // included (they share their table's block ID, TEMPRA-101).
    const sel = selectorAt(text, b.from + 1, b.to - 1);
    expect(locate(text, sel)).toEqual({ from: b.from + 1, to: b.to - 1 });
  }
  return { p, root };
}

describe("the reader counts text as docText does (tempra-dev: app/reader)", () => {
  const all = bodies();

  test("there are bodies to test", () => {
    expect(all.length).toBeGreaterThan(50);
  });

  for (const { file, body } of all) {
    test(file, () => {
      counts(file, stored(body));
    });
  }

  test("a selection across blocks, and points between blocks, snap to the nearest text", () => {
    const md = "# Title\n\nFirst *para*graph.\n\n- one\n- two\n\n> quoted\n\n---\n\nLast.";
    const { p, root } = draw(stored(md));
    const t = p.text;
    // From the start of the body to its end: the whole text.
    expect(offsetAt(root, root, 0, false)).toBe(0);
    expect(offsetAt(root, root, root.childNodes.length, true)).toBe(t.text.length);
    // Around the rule (no text): the end of "quoted", the start of "Last.".
    const hr = root.querySelector("hr") as Element;
    const parent = hr.parentNode as Node;
    const index = Array.prototype.indexOf.call(parent.childNodes, hr);
    expect(offsetAt(root, parent, index, true)).toBe(t.text.indexOf("quoted") + 6);
    expect(offsetAt(root, parent, index + 1, false)).toBe(t.text.indexOf("Last."));
    // A list item's element boundary (between its marker and its paragraph).
    const li = root.querySelector("li") as Element;
    expect(offsetAt(root, li, 0, false)).toBe(t.text.indexOf("one"));
    // A range from inside a heading to inside the list reads as the text between.
    const range = rangeOf(root, 2, t.text.indexOf("two") + 2);
    const from = offsetAt(root, range?.startContainer as Node, range?.startOffset ?? 0, false);
    const to = offsetAt(root, range?.endContainer as Node, range?.endOffset ?? 0, true);
    expect(t.text.slice(from ?? 0, to ?? 0)).toBe("tle\nFirst paragraph.\none\ntw");
  });

  test("inside an atom, a start snaps before it and an end after it", () => {
    const { p, root } = draw(stored("See [^a] here.\n\n[^a]: A note."), {
      footnote: () => ({ href: "#fn-a", mark: "12" }),
    });
    const sup = root.querySelector("sup.fnref") as Element;
    const inner = sup.querySelector("a")?.firstChild as Node;
    const at = p.text.text.indexOf(ATOM);
    expect(offsetAt(root, inner, 1, false)).toBe(at);
    expect(offsetAt(root, inner, 1, true)).toBe(at + 1);
  });

  test("the verification diff's ins and del leave the counting alone", () => {
    for (const { file, body } of bodies().slice(0, 20)) {
      const older = stored(body);
      const tree = stored(
        `Inserted first words.\n\n${body.replace(/\b(the|a)\b/, "one").trimEnd()}\n\nAn added paragraph.\n`,
      );
      const { p, root, diff } = draw(tree, {}, older);
      expect(diff?.added.length).toBeGreaterThan(0);
      const tbs = textblocks(root);
      tbs.forEach((tb, i) => {
        const b = p.text.blocks[i];
        expect({ file, i, text: readText(tb) }).toEqual({
          file,
          i,
          text: p.text.text.slice(b?.from, b?.to),
        });
      });
      const added = [...root.querySelectorAll("ins.diff-added")].map((e) => e.textContent).join("");
      expect(added).toContain("An added paragraph.");
    }
  });
});

describe("what the reader draws", () => {
  test("hrefs come from the caller; unsafe schemes never reach the page", () => {
    const md = "[a](/x.md) [b](javascript:alert(1)) [c](https://e.com) ![i](/img.png) [d](y.md#h)";
    const { html } = draw(stored(md), {
      path: "dir/c.md",
      href: (t, _raw, kind) =>
        t === null
          ? null
          : t.kind === "internal"
            ? `/lib/${t.path}${kind === "image" ? "?raw" : ""}`
            : t.href,
      exists: (path) => path === "x.md",
    });
    expect(html).toContain('href="/lib/x.md"');
    expect(html).not.toContain("javascript:");
    expect(html).toContain('href="https://e.com" rel="noopener noreferrer"');
    expect(html).toContain('src="/lib/img.png?raw"');
    expect(html).toContain('class="internal broken"');
    expect(html).toContain('data-path="dir/y.md"');
  });

  test("footnote markers show what the caller says; headings get the server's anchors", () => {
    const md = "# Intro\n\n## Intro\n\n## `code` & more!\n\nSee [^a] and [^b].\n\n[^a]: Note.";
    const { html, p } = draw(stored(md), {
      footnote: (label, defined) => (defined ? { href: `#src-${label}`, mark: "1" } : null),
    });
    expect(html).toContain('id="intro"');
    expect(html).toContain('id="intro-1"');
    expect(html).toContain('id="code-more"');
    expect(html).toContain(
      '<sup class="fnref" data-atom="" data-label="a"><a href="#src-a" aria-label="footnote 1">1</a>',
    );
    // A reference with no definition is still a marker, with no link.
    expect(html).toContain('<sup class="fnref" data-atom="" data-label="b">[b]</sup>');
    expect(p.headings.map((h) => h.id)).toEqual(["intro", "intro-1", "code-more"]);
    expect(p.headings[0]?.first).toBe(true);
    // The definition is drawn beside the body, not in it.
    expect(html).not.toContain("Note.");
    expect(p.footnotes.map((f) => f.label)).toEqual(["a"]);
    const note = markup(
      put(Note, { prepared: p, nodes: p.footnotes[0]?.node.children ?? [] }).host,
    );
    expect(note).toMatch(/^<p data-block="\w+">Note.<\/p>$/);
  });

  test("markers are numbered in reading order: the body first, then the definitions", () => {
    const seen: string[] = [];
    prepare(stored("A [^x] and [^y].\n\n[^y]: Cites [^z].\n\n[^x]: Plain."), {
      footnote: (label) => {
        seen.push(label);
        return { href: null, mark: String(seen.length) };
      },
    });
    expect(seen).toEqual(["x", "y", "z"]);
  });

  test("attribute values and text are escaped", () => {
    const { html } = draw(
      stored('[x](https://e.com/"onmouseover="alert(1)) ![a"b](https://e.com/i.png "t\\"x")'),
    );
    expect(html).not.toMatch(/"\s*onmouseover=/);
    expect(html).toContain("&quot;");
  });

  test("raw HTML is shown as its markdown, as code, never rendered", () => {
    const { html, root } = draw(
      stored('Hi <img src=x onerror="alert(1)"> there\n\n<div>\nblock\n</div>'),
    );
    // The DOM's serialization escapes `<`, `>` and `&` in text, not quotes; the code's text is
    // checked exactly below.
    expect(html).toContain(
      '<code class="raw" data-atom="">&lt;img src=x onerror="alert(1)"&gt;</code>',
    );
    expect(root.querySelector("code.raw")?.textContent).toBe('<img src=x onerror="alert(1)">');
    expect(root.querySelector("img")).toBeNull();
    expect(root.querySelector("pre.raw code")?.textContent).toBe("<div>\nblock\n</div>");
  });

  test("tables keep their alignment; tasks show a disabled checkbox; a code fence its language", () => {
    const { root } = draw(
      stored("| a | b |\n|:-:|--:|\n| 1 | 2 |\n\n- [x] done\n- [ ] open\n\n```sql\nselect 1\n```"),
    );
    expect(root.querySelector("th")?.getAttribute("data-align")).toBe("center");
    expect(root.querySelectorAll("td")[1]?.getAttribute("data-align")).toBe("right");
    expect(root.querySelector(".table > table")).not.toBeNull();
    const boxes = root.querySelectorAll("li.task input[type=checkbox]");
    expect(boxes.length).toBe(2);
    expect(root.querySelector("pre")?.getAttribute("data-lang")).toBe("sql");
  });

  test("a leading heading can be hidden and keeps its place in the text", () => {
    const p = prepare(stored("# Same as the title\n\nBody."));
    const html = markup(put(Body, { prepared: p, diff: null, hideFirst: true }).host);
    expect(html).toMatch(/^<h1 id="same-as-the-title" data-block="\w+" data-text="0" hidden="">/);
  });
});

/** Internal images to a download path, external ones as they are (as the page view does). */
const hrefs: BodyOptions["href"] = (t, _raw, kind) =>
  t === null
    ? null
    : t.kind === "internal"
      ? `/o/l/-/${kind === "image" ? "download" : "file"}/${t.path}`
      : t.href;

const FIGURES = [
  "# Figures",
  "Before the figures.",
  '![A tower](assets/tower.png "The tower at dusk")',
  "Text with ![an icon](assets/icon.png) inline, and more words.",
  "![Only alt](https://e.com/photo.jpg)",
  "![](assets/bare.png)",
  '```mermaid title="A write goes through the ledger"\nflowchart LR\n  A --> B\n```',
  "- ![In a list](assets/list.png)\n- an item",
  "> ![Quoted](assets/quoted.png)",
  "```mermaid\nflowchart LR\n  C --> D\n```",
  "After the figures.",
].join("\n\n");

/**
 * A DOM for components with effects and events: the page's one DOM (test/setup.ts), with
 * `window` handed to the test for its events.
 */
async function live<T>(fn: (window: Window & typeof globalThis) => Promise<T>): Promise<T> {
  try {
    return await fn(window);
  } finally {
    // Let scheduled work (Pele's chunks, timers) run before the next test.
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** Lets effects, promises and timers run, then flushes. */
async function act(fn: () => unknown = () => {}) {
  await fn();
  await new Promise((r) => setTimeout(r, 0));
  flushSync();
}

describe("figures (tempra-dev: app/reader, Figures)", () => {
  test("the reader's counting holds with figures, captions and diagrams in the body", () => {
    counts("figures", stored(FIGURES), { href: hrefs, path: "c.md" });
    // With no href (images dropped) too.
    counts("figures, no href", stored(FIGURES));
  });

  test("an image alone in its paragraph is a numbered figure; one in running text stays inline", () => {
    const { p, root } = draw(stored(FIGURES), { href: hrefs, path: "c.md" });
    const figures = [...root.querySelectorAll("figure")];
    const captions = figures.map((f) => f.querySelector("figcaption")?.textContent);
    expect(captions).toEqual([
      "Figure 1. The tower at dusk",
      "Figure 2. Only altFrom e.com",
      "Figure 3.",
      "Figure 4. A write goes through the ledger",
      "Figure 5. In a list",
      "Figure 6. Quoted",
      "Figure 7.",
    ]);
    expect(p.figures.map((f) => [f.n, f.kind])).toEqual([
      [1, "image"],
      [2, "image"],
      [3, "image"],
      [4, "diagram"],
      [5, "image"],
      [6, "image"],
      [7, "diagram"],
    ]);
    // The figure is the block; its paragraph keeps the textblock with the image's one atom.
    const first = figures[0] as Element;
    expect(first.className).toBe("figure");
    expect(first.hasAttribute("data-block")).toBe(true);
    const para = first.querySelector(":scope > p[data-text]") as Element;
    expect(para.querySelectorAll("[data-atom]").length).toBe(1);
    expect(para.querySelector("[data-atom] img")?.getAttribute("src")).toBe(
      "/o/l/-/download/assets/tower.png",
    );
    expect(readText(para)).toBe(ATOM);
    // The caption is not text: outside the textblock and marked data-skip.
    const caption = first.querySelector("figcaption") as Element;
    expect(caption.hasAttribute("data-skip")).toBe(true);
    expect(caption.closest("[data-text]")).toBeNull();
    // An image in running text: inline, its own atom, no figure and no caption.
    const inline = root.querySelector('img[alt="an icon"]') as Element;
    expect(inline.hasAttribute("data-atom")).toBe(true);
    expect(inline.closest("figure")).toBeNull();
    expect(inline.parentElement?.tagName).toBe("P");
    // Image paths: internal ones resolve against the page's path.
    expect(p.figures[0]?.kind === "image" && p.figures[0].path).toBe("assets/tower.png");
    expect(p.figures[1]?.kind === "image" && p.figures[1].path).toBeNull();
  });

  test("a figure's caption never enters a selection's text", () => {
    const { p, root } = draw(stored(FIGURES), { href: hrefs, path: "c.md" });
    const t = p.text.text;
    const caption = root.querySelector("figcaption") as Element;
    // Its last text (Svelte's comment anchors are not text).
    const inCaption = [...caption.childNodes]
      .filter((n) => n.nodeType === 3 && n.textContent)
      .at(-1) as Node;
    expect(inCaption.textContent).toBe(" The tower at dusk");
    // A point in the caption snaps to the text after it (a start) or the figure's atom (an end).
    const before = t.indexOf("Before the figures.");
    const atom = t.indexOf(ATOM, before);
    const next = t.indexOf("Text with");
    expect(offsetAt(root, inCaption, 2, false)).toBe(next);
    expect(offsetAt(root, inCaption, 2, true)).toBe(atom + 1);
    // A selection from the paragraph before, across the figure and its caption, into the next.
    const doc = root.ownerDocument;
    const range = doc.createRange();
    const start = pointAt(root, before + 7);
    const end = pointAt(root, next + 4);
    if (!start || !end) throw new Error("no points");
    range.setStart(start.node, start.offset);
    range.setEnd(end.node, end.offset);
    expect(range.toString()).toContain("The tower at dusk");
    const from = offsetAt(root, range.startContainer, range.startOffset, false) ?? 0;
    const to = offsetAt(root, range.endContainer, range.endOffset, true) ?? 0;
    expect(t.slice(from, to)).toBe(`the figures.\n${ATOM}\nText`);
    expect(t).not.toContain("Figure 1");
    expect(t).not.toContain("dusk");
  });

  test("a fence's caption comes from its title; other meta is not a caption", () => {
    expect(fenceTitle('title="A flow"')).toBe("A flow");
    expect(fenceTitle("title='Single'")).toBe("Single");
    expect(fenceTitle("theme=dark title=Word")).toBe("Word");
    expect(fenceTitle("subtitle=no")).toBeNull();
    expect(fenceTitle(null)).toBeNull();
  });

  test("an image is an enlarge button only where the reader offers the full-screen view", () => {
    const p = prepare(stored(FIGURES), { href: hrefs, path: "c.md" });
    const plain = markup(put(Body, { prepared: p, diff: null, hideFirst: false }).host);
    expect(plain).not.toContain("figure-open");
    const offered = markup(put(Body, { prepared: p, diff: null, hideFirst: false }, () => {}).host);
    expect(offered).toContain('aria-label="Enlarge image: A tower"');
    // The button is inside the atom: the counting is the same.
    const root = document.createElement("div");
    root.innerHTML = offered;
    const para = root.querySelector("figure p[data-text]") as unknown as Element;
    expect(para.querySelector("[data-atom] > button.figure-open > img")).not.toBeNull();
    expect(readText(para)).toBe(ATOM);
  });

  test("an image that fails to load shows the broken box, still one atom", async () => {
    await live(async (window) => {
      const p = prepare(stored(FIGURES), { href: hrefs, path: "c.md" });
      const { host, root } = put(Body, { prepared: p, diff: null, hideFirst: false });
      const img = host.querySelector('img[alt="A tower"]') as HTMLImageElement;
      await act(async () => {
        img.dispatchEvent(new window.Event("error"));
      });
      const figure = host.querySelector("figure.figure") as HTMLElement;
      const box = figure.querySelector(".figure-broken") as HTMLElement;
      expect(box).not.toBeNull();
      expect(box.hasAttribute("data-atom")).toBe(true);
      expect(box.getAttribute("role")).toBe("img");
      expect(box.textContent).toContain("This image can't be shown");
      expect(box.textContent).toContain("assets/tower.png");
      expect(box.textContent).toContain("“A tower”");
      expect(figure.querySelector("img")).toBeNull();
      const para = figure.querySelector("p[data-text]") as unknown as Element;
      expect(readText(para)).toBe(ATOM);
      expect(figure.querySelector("figcaption")?.textContent).toBe("Figure 1. The tower at dusk");
      // An inline image that fails: its alt text, still one atom.
      const icon = host.querySelector('img[alt="an icon"]') as HTMLImageElement;
      await act(async () => {
        icon.dispatchEvent(new window.Event("error"));
      });
      const broken = host.querySelector(".image-broken") as HTMLElement;
      expect(broken.hasAttribute("data-atom")).toBe(true);
      expect(broken.textContent).toBe("an icon");
      // Offsets still hold over the whole body.
      const text = p.text;
      for (const tb of textblocks(host as unknown as Element)) {
        const at = Number(tb.getAttribute("data-text"));
        const b = text.blocks.find((x) => x.from === at);
        expect(readText(tb)).toBe(text.text.slice(b?.from, b?.to));
      }
      await act(async () => root.unmount());
    });
  });

  test("an external image names its site under the caption, outside the text", () => {
    const md = [
      "![Only alt](https://www.e.com/photo.jpg)",
      "![Ours](assets/ours.png)",
      'Text with ![a badge](//badges.io/b.svg "Build") and ![mine](assets/m.png).',
      ':::figure\n![One](https://a.org/1.png "First")\n![Two](https://b.org/2.png "Second")\n:::',
    ].join("\n\n");
    const { p, root } = draw(stored(md), { href: hrefs, path: "c.md" });
    expect(p.figures.map((f) => (f.kind === "image" ? f.host : null))).toEqual([
      "e.com",
      null,
      "a.org",
      "b.org",
    ]);
    const captions = [...root.querySelectorAll("figcaption")].map((c) => c.textContent);
    expect(captions).toEqual([
      "Figure 1. Only altFrom e.com",
      "Figure 2. Ours",
      "Figures 3 and 4.From a.org, b.org",
    ]);
    const source = root.querySelector("figcaption .figure-source") as Element;
    expect(source.closest("[data-skip]")).not.toBeNull();
    expect(source.querySelector("a")).toBeNull();
    expect(p.text.text).not.toContain("e.com");
    // Inline: a tooltip only, no line.
    expect(root.querySelector('img[alt="a badge"]')?.getAttribute("title")).toBe(
      "Build (from badges.io)",
    );
    expect(root.querySelector('img[alt="mine"]')?.hasAttribute("title")).toBe(false);
  });

  test("an external image that fails says it is external, and from where", async () => {
    await live(async (window) => {
      const md = "![A chart](https://charts.example.com/c.png)\n\nSee ![dot](https://x.io/d.png).";
      const p = prepare(stored(md), { href: hrefs, path: "c.md" });
      const { host, root } = put(Body, { prepared: p, diff: null, hideFirst: false });
      for (const alt of ["A chart", "dot"]) {
        const img = host.querySelector(`img[alt="${alt}"]`) as HTMLImageElement;
        await act(async () => {
          img.dispatchEvent(new window.Event("error"));
        });
      }
      const box = host.querySelector(".figure-broken") as HTMLElement;
      expect(box.textContent).toContain("This image can't be shown");
      expect(box.textContent).toContain("An external image from charts.example.com");
      expect(box.getAttribute("aria-label")).toBe(
        "This external image from charts.example.com can't be shown: A chart",
      );
      const inline = host.querySelector(".image-broken") as HTMLElement;
      expect(inline.getAttribute("title")).toBe("This external image from x.io can't be shown");
      const para = host.querySelector("figure p[data-text]") as unknown as Element;
      expect(readText(para)).toBe(ATOM);
      await act(async () => root.unmount());
    });
  });

  test("the full-screen view: opens on a figure, previous and next, facts, Escape closes", async () => {
    await live(async (window) => {
      const md = [
        '![A tower](assets/tower.png "The tower at dusk")',
        "Between.",
        "![A remote photo](https://e.com/photo.jpg)",
        "Words ![inline](assets/i.png) here.",
      ].join("\n\n");
      const p = prepare(stored(md), { href: hrefs, path: "c.md" });
      const asked: string[] = [];
      const view: FigureView = {
        title: "Diagrams",
        describe: async (path) => {
          asked.push(path);
          return { size: 316 * 1024, by: "ann", at: "2026-10-18T10:00:00Z" };
        },
        fileHref: (path) => `/o/l/${path}`,
      };
      const { host, root } = put(Reader, {
        prepared: p,
        diff: null,
        hideFirst: false,
        figureView: view,
      });
      expect(host.querySelector("dialog")).toBeNull();
      const button = host.querySelector("button.figure-open") as HTMLButtonElement;
      expect(button.getAttribute("aria-label")).toBe("Enlarge image: A tower");
      await act(async () => button.click());
      await act(() => new Promise((r) => setTimeout(r, 0)));
      const dialog = () => host.querySelector("dialog.lightbox") as HTMLDialogElement | null;
      const d = dialog() as HTMLDialogElement;
      expect(d).not.toBeNull();
      expect(d.open).toBe(true);
      const label = d.ownerDocument.getElementById(d.getAttribute("aria-labelledby") ?? "");
      expect(label?.textContent).toBe("fig. 1 of 2");
      expect(d.querySelector(".lightbox-where")?.textContent).toBe("Diagrams");
      expect(d.querySelector(".lightbox-figure img")?.getAttribute("src")).toBe(
        "/o/l/-/download/assets/tower.png",
      );
      expect(d.querySelector(".lightbox-caption")?.textContent).toBe("The tower at dusk");
      const links = [...d.querySelectorAll(".lightbox-actions a")];
      // Download, and Open file: the image's attachment page.
      expect(links.map((a) => a.textContent?.trim())).toEqual(["Download", "Open file"]);
      expect(links[0]?.getAttribute("href")).toBe("/o/l/-/download/assets/tower.png");
      expect(links[0]?.hasAttribute("download")).toBe(true);
      expect(links[1]?.getAttribute("href")).toBe("/o/l/assets/tower.png");
      expect(asked).toEqual(["assets/tower.png"]);
      const facts = () => d.querySelector(".lightbox-facts")?.textContent ?? "";
      expect(facts()).toMatch(/^tower\.png · 316 KB · added by ann, /);
      const prev = d.querySelector(".lightbox-prev") as HTMLButtonElement;
      expect(prev.disabled).toBe(true);
      // Next: the external image, its URL and nothing asked.
      await act(async () => (d.querySelector(".lightbox-next") as HTMLButtonElement).click());
      expect(dialog()?.open).toBe(true);
      expect(label?.textContent).toBe("fig. 2 of 2");
      expect(facts()).toMatch(/^https:\/\/e\.com\/photo\.jpg/);
      // An external image has no page here: Open original, in a new tab.
      const outside = [...d.querySelectorAll(".lightbox-actions a")];
      expect(outside.map((a) => a.textContent?.trim())).toEqual(["Download", "Open original"]);
      expect(outside[1]?.getAttribute("target")).toBe("_blank");
      expect(asked).toEqual(["assets/tower.png"]);
      expect((d.querySelector(".lightbox-next") as HTMLButtonElement).disabled).toBe(true);
      // The arrow keys move too.
      const key = (k: string) =>
        act(async () => {
          d.dispatchEvent(new window.KeyboardEvent("keydown", { key: k, bubbles: true }));
        });
      await key("ArrowLeft");
      expect(label?.textContent).toBe("fig. 1 of 2");
      // Escape closes.
      await key("Escape");
      expect(dialog()).toBeNull();
      await act(async () => root.unmount());
    });
  });

  test("the full-screen view works with nothing from the page, and steps onto diagrams", async () => {
    await live(async () => {
      const md = '![](assets/a.png)\n\n```mermaid title="Flow"\nflowchart LR\n  A --> B\n```';
      const p = prepare(stored(md), { href: hrefs, path: "c.md" });
      const { host, root } = put(Reader, { prepared: p, diff: null, hideFirst: false });
      await act(async () => (host.querySelector("button.figure-open") as HTMLElement).click());
      const d = host.querySelector("dialog.lightbox") as HTMLDialogElement;
      expect(d.querySelector(".lightbox-where")).toBeNull();
      expect(d.querySelector(".lightbox-caption")).toBeNull();
      expect(d.querySelector(".lightbox-facts > span")?.textContent).toBe("a.png");
      await act(async () => (d.querySelector(".lightbox-next") as HTMLButtonElement).click());
      expect(d.querySelector(".lightbox-actions a")).toBeNull();
      expect(d.querySelector(".lightbox-caption")?.textContent).toBe("Flow");
      for (let i = 0; i < 100 && !d.querySelector(".lightbox-diagram svg"); i++) {
        await act(() => new Promise((r) => setTimeout(r, 10)));
      }
      expect(d.querySelector(".lightbox-diagram svg")).not.toBeNull();
      await act(async () => (d.querySelector('[aria-label="Close"]') as HTMLElement).click());
      expect(host.querySelector("dialog")).toBeNull();
      await act(async () => root.unmount());
    });
  });
});

/** Figure markup in each form (TEMPRA-161; tempra-dev: app/media, Figure markup). */
const MARKUP = [
  "# Figure markup",
  "Before the figures.",
  ':::figure{width=480 frame}\n![The sign-in page](assets/signin.png "Sign-in")\n:::',
  ":::figure{width=60%}\n![A chart](assets/chart.png)\n:::",
  ':::figure{layout=wide}\n![The workspace](assets/wide.png "The whole frame")\n:::',
  ":::figure[A labelled one]{layout=full}\n![The page](assets/full.png)\n:::",
  ':::figure[The top bar *before* and after[^src]]{layout=wide}\n![Crumbs](assets/before.png "Before")\n![The path](assets/after.png "After")\n:::',
  ":::figure[Four]\n![1](assets/1.png)\n![2](assets/2.png)\n![3](assets/3.png)\n![4](https://e.com/4.png)\n:::",
  "Between ![an icon](assets/icon.png) the figures.",
  ":::figure{layout=sideways}\n![Broken markup](assets/broken.png)\n:::",
  ':::note{kind="aside"}\nAn unknown *directive*, kept as written.\n:::',
  "- in a list\n\n  :::figure{layout=wide}\n  ![Listed](assets/listed.png)\n  :::",
  '![A plain one](assets/plain.png "Plain")',
  "After the figures.",
].join("\n\n");

describe("figure markup (TEMPRA-161)", () => {
  test("the reader's counting holds with every form", () => {
    counts("markup", stored(MARKUP), { href: hrefs, path: "c.md" });
    counts("markup, no href", stored(MARKUP));
    // And across a diff.
    const older = stored(MARKUP.replace("Before the figures.", "Before figures."));
    const { p, root } = draw(stored(MARKUP), { href: hrefs, path: "c.md" }, older);
    for (const tb of textblocks(root)) {
      const at = Number(tb.getAttribute("data-text"));
      const b = p.text.blocks.find((x) => x.from === at);
      expect(readText(tb)).toBe(p.text.text.slice(b?.from, b?.to));
    }
  });

  test("each image is a figure in the numbering; a group has one caption", () => {
    const { p, root } = draw(stored(MARKUP), { href: hrefs, path: "c.md" });
    expect(p.figures.map((f) => [f.n, f.kind === "image" ? f.alt : ""])).toEqual([
      [1, "The sign-in page"],
      [2, "A chart"],
      [3, "The workspace"],
      [4, "The page"],
      [5, "Crumbs"],
      [6, "The path"],
      [7, "1"],
      [8, "2"],
      [9, "3"],
      [10, "4"],
      [11, "Broken markup"],
      [12, "Listed"],
      [13, "A plain one"],
    ]);
    const figures = [...root.querySelectorAll("figure")];
    expect(figures.map((f) => f.querySelector(":scope > figcaption")?.textContent)).toEqual([
      "Figure 1. Sign-in",
      "Figure 2. A chart",
      "Figure 3. The whole frame",
      "Figure 4. A labelled one",
      "Figures 5 and 6. The top bar before and after[src]",
      "Figures 7–10. FourFrom e.com",
      "Figure 11. Broken markup",
      "Figure 12. Listed",
      "Figure 13. Plain",
    ]);
    expect(figures.map((f) => f.className)).toEqual([
      "figure figure-framed figure-sized",
      "figure figure-sized",
      "figure figure-wide",
      "figure figure-full",
      "figure figure-wide figure-group figure-n-2",
      "figure figure-group figure-n-4",
      "figure",
      "figure figure-wide",
      "figure",
    ]);
    // No style attribute in the markup: the width goes through the CSSOM, so the only styles are
    // the sized figures' `--figure-width`, set once they are drawn.
    const styled = [...root.querySelectorAll("[style]")] as HTMLElement[];
    expect(styled.map((el) => el.className)).toEqual(
      figures.map((f) => f.className).filter((c) => c.includes("figure-sized")),
    );
    for (const el of styled) {
      expect(Array.from({ length: el.style.length }, (_, i) => el.style.item(i))).toEqual([
        "--figure-width",
      ]);
    }
    // A group: one textblock, its images one atom each, in cells with their labels.
    const group = figures[4] as Element;
    const row = group.querySelector(":scope > p.figure-row[data-text]") as Element;
    expect(row.querySelectorAll("[data-atom]").length).toBe(2);
    expect(readText(row)).toBe(`${ATOM}\n${ATOM}`);
    expect([...row.querySelectorAll(".figure-label")].map((l) => l.textContent)).toEqual([
      "Before",
      "After",
    ]);
    expect(row.querySelector(".figure-label")?.hasAttribute("data-skip")).toBe(true);
    // The group caption is outside the text and counts nothing.
    const caption = group.querySelector("figcaption") as Element;
    expect(caption.hasAttribute("data-skip")).toBe(true);
    expect(caption.closest("[data-text]")).toBeNull();
    expect(p.text.text).not.toContain("The top bar");
    expect(p.text.text).not.toContain("Four");
    expect(p.text.text).not.toContain("A labelled one");
  });

  test("markup that does not parse and other directives show their lines as markdown", () => {
    const { root } = draw(stored(MARKUP), { href: hrefs, path: "c.md" });
    const raw = [...root.querySelectorAll(".directive")];
    expect(raw).toHaveLength(2);
    expect(raw.map((d) => [...d.querySelectorAll(".raw-fence")].map((f) => f.textContent))).toEqual(
      [
        [":::figure{layout=sideways}", ":::"],
        [":::note{kind=aside}", ":::"],
      ],
    );
    for (const d of raw) {
      for (const f of d.querySelectorAll(".raw-fence")) {
        expect(f.hasAttribute("data-skip")).toBe(true);
      }
    }
    // Their content draws as usual: the image as a plain figure, the text as a paragraph.
    expect(raw[0]?.querySelector("figure img")?.getAttribute("alt")).toBe("Broken markup");
    expect(raw[1]?.querySelector("p[data-text]")?.textContent).toBe(
      "An unknown directive, kept as written.",
    );
  });

  test("the width is set through the CSSOM; the full-screen view steps through a group", async () => {
    await live(async () => {
      const md = [
        ':::figure{width=480}\n![One](assets/one.png "One")\n:::',
        ':::figure[Two of them]\n![A](assets/a.png "A")\n![B](assets/b.png "B")\n:::',
      ].join("\n\n");
      const p = prepare(stored(md), { href: hrefs, path: "c.md" });
      const { host, root } = put(Reader, { prepared: p, diff: null, hideFirst: false });
      const [one, two] = [...host.querySelectorAll("figure")] as HTMLElement[];
      expect(one?.style.getPropertyValue("--figure-width")).toBe("480px");
      expect(two?.style.getPropertyValue("--figure-width")).toBe("");
      const buttons = [...host.querySelectorAll("button.figure-open")] as HTMLButtonElement[];
      expect(buttons).toHaveLength(3);
      await act(async () => buttons[1]?.click());
      await act(() => new Promise((r) => setTimeout(r, 0)));
      const d = host.querySelector("dialog.lightbox") as HTMLDialogElement;
      const label = () =>
        d.ownerDocument.getElementById(d.getAttribute("aria-labelledby") ?? "")?.textContent;
      expect(label()).toBe("fig. 2 of 3");
      expect(d.querySelector(".lightbox-caption")?.textContent).toBe("A");
      await act(async () => (d.querySelector(".lightbox-next") as HTMLButtonElement).click());
      expect(label()).toBe("fig. 3 of 3");
      expect(d.querySelector(".lightbox-figure img")?.getAttribute("src")).toBe(
        "/o/l/-/download/assets/b.png",
      );
      await act(async () => root.unmount());
    });
  });
});

const CITED = [
  "Before the figures.",
  '![A mountain ridge](assets/ridge.jpg "Fronalpstock panorama")[^fronalp]',
  "![](assets/bare.png) [^a][^b]",
  "![An icon](assets/icon.png)[^a] and words after it.",
  ':::figure{width=480}\n![One](assets/one.png "One")[^b]\n:::',
  ':::figure[Two]\n![L](assets/l.png "Left")[^a]\n![R](assets/r.png "Right")\n:::',
  "After the figures.",
  "[^fronalp]: Fronalpstock.",
  "[^a]: A.",
  "[^b]: B.",
].join("\n\n");

/** Markers numbered by label, as the page view numbers sources. */
const numbered: BodyOptions["footnote"] = (label) => ({
  href: `#src-${label}`,
  mark: String(["fronalp", "a", "b"].indexOf(label) + 1),
});

describe("an image with its footnote is a figure (TEMPRA-218)", () => {
  const options: BodyOptions = { href: hrefs, path: "c.md", footnote: numbered };

  test("the reader's counting holds, with and without a diff", () => {
    counts("cited", stored(CITED), options);
    counts("cited, no href", stored(CITED));
    const older = stored(CITED.replace("Before the figures.", "Before figures."));
    const { p, root } = draw(stored(CITED), options, older);
    for (const tb of textblocks(root)) {
      const at = Number(tb.getAttribute("data-text"));
      const b = p.text.blocks.find((x) => x.from === at);
      expect(readText(tb)).toBe(p.text.text.slice(b?.from, b?.to));
    }
  });

  test("the marker ends the caption, an atom of the figure's textblock", () => {
    const { p, root } = draw(stored(CITED), options);
    expect(p.figures.map((f) => [f.n, f.kind === "image" ? f.notes.length : -1])).toEqual([
      [1, 1],
      [2, 2],
      [3, 1],
      [4, 1],
      [5, 0],
    ]);
    const figures = [...root.querySelectorAll("figure")];
    expect(figures.map((f) => f.querySelector(":scope > figcaption")?.textContent)).toEqual([
      "Figure 1. Fronalpstock panorama1",
      "Figure 2. 23", // the space is the hidden gap between the image and its markers
      "Figure 3. One3",
      "Figures 4 and 5. Two",
    ]);
    // The figure is the textblock: the image's atom, then the marker's, as docText reads them.
    const first = figures[0] as Element;
    const ridge = p.figures[0];
    const at = ridge?.kind === "image" ? p.starts.get(ridge.node) : undefined;
    expect(first.getAttribute("data-text")).toBe(String(at));
    expect(first.querySelector("p")?.hasAttribute("data-text")).toBe(false);
    expect(readText(first)).toBe(`${ATOM}${ATOM}`);
    const caption = first.querySelector("figcaption") as Element;
    expect(caption.hasAttribute("data-skip")).toBe(false);
    expect(caption.querySelector(":scope > [data-skip]")?.textContent).toBe(
      "Figure 1. Fronalpstock panorama",
    );
    const sup = caption.querySelector("sup.fnref") as Element;
    expect(sup.hasAttribute("data-atom")).toBe(true);
    expect(sup.closest("[data-skip]")).toBeNull();
    expect(sup.querySelector("a")?.getAttribute("href")).toBe("#src-fronalp");
    expect(sup.querySelector("a")?.getAttribute("aria-label")).toBe("footnote 1");
    // Its card: the marker in the caption is a footnote marker like any other.
    expect(hoveredOf(sup)).toEqual({ kind: "footnote", label: "fronalp" });
    // The marker's offset is the paragraph's second character, there and back.
    const point = pointAt(root, (at ?? 0) + 1);
    expect(point && offsetAt(root, point.node, point.offset, false)).toBe((at ?? 0) + 1);
    // No title or alt: the markers still end the caption line; the space between is hidden text.
    const bare = figures[1] as Element;
    expect(readText(bare)).toBe(`${ATOM} ${ATOM}${ATOM}`);
    expect(bare.querySelector("figcaption .figure-gap")?.textContent).toBe(" ");
    // Any other text and the image stays inline, with its marker in the text.
    const icon = root.querySelector('img[alt="An icon"]') as Element;
    expect(icon.closest("figure")).toBeNull();
    expect(icon.closest("p")?.querySelector("sup.fnref")).not.toBeNull();
  });

  test("in figure markup: one image's marker ends the caption, a group's its label", () => {
    const { root } = draw(stored(CITED), options);
    const [, , one, group] = [...root.querySelectorAll("figure")] as Element[];
    expect(one?.getAttribute("data-text")).not.toBeNull();
    expect(one?.querySelector("p")?.hasAttribute("data-text")).toBe(false);
    expect(readText(one as Element)).toBe(`${ATOM}${ATOM}`);
    expect(one?.querySelector("figcaption sup.fnref")?.getAttribute("data-label")).toBe("b");
    const row = group?.querySelector("p.figure-row[data-text]") as Element;
    expect(readText(row)).toBe(`${ATOM}${ATOM}\n${ATOM}`);
    expect([...row.querySelectorAll(".figure-label")].map((l) => l.textContent)).toEqual([
      "Left2",
      "Right",
    ]);
    expect(row.querySelector(".figure-label sup.fnref")?.closest("[data-skip]")).toBeNull();
    expect(group?.querySelector("figcaption")?.hasAttribute("data-skip")).toBe(true);
  });

  test("markers keep their reading order, so the sources' numbers stay", () => {
    const seen: string[] = [];
    prepare(stored(CITED), {
      footnote: (label) => {
        seen.push(label);
        return { href: null, mark: String(seen.length) };
      },
    });
    expect(seen).toEqual(["fronalp", "a", "b", "a", "b", "a"]);
  });
});

describe("right-sized images (TEMPRA-162)", () => {
  const urls = new Urls("o", "l");
  const H = (c: string) => c.repeat(64);
  /** What the page's JSON says of each image (`images`), as the page view reads it. */
  const known: Record<string, ImageRef> = {
    "assets/signin.png": { hash: H("a"), media: "image/png", width: 2400, height: 1500 },
    "assets/wide.png": { hash: H("b"), media: "image/jpeg", width: 1000, height: 2000 },
    "assets/before.png": { hash: H("c"), media: "image/png", width: 800, height: 400 },
    "assets/after.png": { hash: H("d"), media: "image/png", width: 300, height: 200 },
    "assets/icon.png": { hash: H("e"), media: "image/png", width: 32, height: 32 },
    "assets/full.png": { hash: H("f"), media: "image/gif", width: 640, height: 480 },
    // From before TEMPRA-152 and not yet worked out, or one that does not decode.
    "assets/chart.png": { hash: H("1"), media: "image/png" },
    "assets/plain.png": { hash: H("2"), media: "image/png", width: null, height: null },
  };
  const options: BodyOptions = {
    href: hrefs,
    path: "c.md",
    image: (path) => (known[path] ? imageSource(urls, known[path]) : null),
  };
  const imgOf = (root: Element, alt: string) => root.querySelector(`img[alt="${alt}"]`) as Element;

  test("from the image route, with the stored width and height and srcset up to its own width", () => {
    const { root } = draw(stored(MARKUP), options);
    const signin = imgOf(root, "The sign-in page");
    expect(signin.getAttribute("src")).toBe(`/o/l/-/image/${H("a")}`);
    expect(signin.getAttribute("width")).toBe("2400");
    expect(signin.getAttribute("height")).toBe("1500");
    expect(signin.getAttribute("loading")).toBe("lazy");
    expect(signin.getAttribute("class")).toBe("image-loading");
    // Every edge under its long edge, described by the width it comes at, then the original.
    expect(signin.getAttribute("srcset")).toBe(
      [
        `/o/l/-/image/${H("a")}?w=320 320w`,
        `/o/l/-/image/${H("a")}?w=640 640w`,
        `/o/l/-/image/${H("a")}?w=768 768w`,
        `/o/l/-/image/${H("a")}?w=1092 1092w`,
        `/o/l/-/image/${H("a")}?w=1280 1280w`,
        `/o/l/-/image/${H("a")}?w=1568 1568w`,
        `/o/l/-/image/${H("a")}?w=1920 1920w`,
        `/o/l/-/image/${H("a")} 2400w`,
      ].join(", "),
    );
    // width=480 caps it; on a phone it spans the screen.
    expect(signin.getAttribute("sizes")).toBe("(max-width: 900px) 100vw, 480px");
    // A portrait image: its edges are its long side, so a 640 one is 320 wide.
    const wide = imgOf(root, "The workspace");
    expect(wide.getAttribute("srcset")?.split(", ").slice(0, 2)).toEqual([
      `/o/l/-/image/${H("b")}?w=320 160w`,
      `/o/l/-/image/${H("b")}?w=640 320w`,
    ]);
    expect(wide.getAttribute("srcset")).toEndWith(`/o/l/-/image/${H("b")} 1000w`);
    expect(wide.getAttribute("sizes")).toBe("(max-width: 900px) 100vw, 960px");
    // A group: each image its share of the row.
    expect(imgOf(root, "Crumbs").getAttribute("sizes")).toBe("(max-width: 900px) 100vw, 480px");
    expect(imgOf(root, "Crumbs").getAttribute("srcset")).toBe(
      `/o/l/-/image/${H("c")}?w=320 320w, /o/l/-/image/${H("c")}?w=640 640w, /o/l/-/image/${H("c")}?w=768 768w, /o/l/-/image/${H("c")} 800w`,
    );
    // Smaller than every edge: the original alone, with its size.
    const after = imgOf(root, "The path");
    expect(after.hasAttribute("srcset")).toBe(false);
    expect(after.hasAttribute("sizes")).toBe(false);
    expect(after.getAttribute("width")).toBe("300");
    // A GIF keeps its frames: its size, no variants.
    const gif = imgOf(root, "The page");
    expect(gif.getAttribute("width")).toBe("640");
    expect(gif.hasAttribute("srcset")).toBe(false);
    // An image in running text: the same route and size.
    const icon = imgOf(root, "an icon");
    expect(icon.getAttribute("src")).toBe(`/o/l/-/image/${H("e")}`);
    expect(icon.getAttribute("width")).toBe("32");
    expect(icon.hasAttribute("data-atom")).toBe(true);
  });

  test("without a known size, just the original; unknown images keep their download", () => {
    const { root } = draw(stored(MARKUP), options);
    for (const alt of ["A chart", "A plain one"]) {
      const img = imgOf(root, alt);
      expect(img.getAttribute("src")).toStartWith("/o/l/-/image/");
      expect(img.hasAttribute("width")).toBe(false);
      expect(img.hasAttribute("height")).toBe(false);
      expect(img.hasAttribute("srcset")).toBe(false);
      expect(img.hasAttribute("class")).toBe(false);
    }
    // Not in `images` (a missing file, an earlier version's): the href, as before.
    expect(imgOf(root, "Listed").getAttribute("src")).toBe("/o/l/-/download/assets/listed.png");
    expect(imgOf(root, "4").getAttribute("src")).toBe("https://e.com/4.png");
    // Counting is unchanged.
    counts("markup, right-sized", stored(MARKUP), options);
  });

  test("the grey box goes once the image loads; the full-screen view downloads the original", async () => {
    await live(async (window) => {
      const tree = stored(':::figure\n![Big](assets/signin.png "Big")\n:::');
      const p = prepare(tree, options);
      let opened = 0;
      const { host } = put(Body, { prepared: p, diff: null, hideFirst: false }, () => opened++);
      const img = host.querySelector("img") as HTMLImageElement;
      expect(img.className).toBe("image-loading");
      await act(async () => {
        img.dispatchEvent(new window.Event("load"));
      });
      expect(img.className).toBe("");
      const figure = p.figures[0];
      if (figure?.kind !== "image") throw new Error("no figure");
      const { host: box } = put(Lightbox, {
        figures: p.figures,
        at: 1,
        view: { downloadHref: (path) => `/o/l/-/download/${path}` },
        onMove: () => {},
        onClose: () => {},
      });
      const big = box.querySelector(".lightbox-figure img") as HTMLImageElement;
      expect(big.getAttribute("sizes")).toBe("100vw");
      expect(big.getAttribute("srcset")).toContain("?w=1920 1920w");
      expect(big.hasAttribute("loading")).toBe(false);
      const download = [...box.querySelectorAll("a")].find((a) =>
        a.textContent?.includes("Download"),
      );
      expect(download?.getAttribute("href")).toBe("/o/l/-/download/assets/signin.png");
    });
  });
});

describe("video, audio and PDF figures (TEMPRA-164)", () => {
  const urls = new Urls("o", "l");
  const H = (c: string) => c.repeat(64);
  const known: Record<string, ImageRef> = {
    "clips/demo.webm": {
      hash: H("a"),
      media: "video/webm",
      size: 2542,
      width: 640,
      height: 360,
      poster: { hash: H("b"), media: "image/png", size: 90, width: 640, height: 360 },
    },
    "clips/raw.mp4": { hash: H("c"), media: "video/mp4", size: 1269 },
    "clips/tone.ogg": { hash: H("d"), media: "audio/ogg", size: 4138 },
    "docs/paper.pdf": { hash: H("e"), media: "application/pdf", size: 1_288_490 },
    "assets/tower.png": { hash: H("f"), media: "image/png", width: 40, height: 20 },
  };
  const options: BodyOptions = {
    href: hrefs,
    path: "c.md",
    image: (path) => (known[path] ? attachmentSource(urls, known[path], path) : null),
  };
  const MEDIA = [
    "# Media",
    '![A tower](assets/tower.png "The tower")',
    '![A 20-second walkthrough](clips/demo.webm "The walkthrough")',
    "![No poster](clips/raw.mp4)",
    "![A tone](clips/tone.ogg)",
    '![The paper](docs/paper.pdf "The paper")',
    "Inline ![a clip](clips/demo.webm) in text.",
    ":::figure{width=480}\n![Grouped](clips/demo.webm)\n:::",
    "![Missing](clips/gone.webm)",
  ].join("\n\n");

  test("each type is drawn by the registry, one atom each, numbered with the images", () => {
    const { p, root } = draw(stored(MEDIA), options);
    // The counting holds: every media figure is one atom in docText.
    counts("media", stored(MEDIA), options);
    expect(p.figures.map((f) => f.n)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(root.querySelectorAll("figcaption .figure-number").length).toBe(7);
    const video = root.querySelector('video[aria-label="A 20-second walkthrough"]') as Element;
    expect(video.getAttribute("src")).toBe(`/o/l/-/media/${H("a")}`);
    expect(video.getAttribute("preload")).toBe("metadata");
    expect(video.hasAttribute("controls")).toBe(true);
    expect(video.hasAttribute("autoplay")).toBe(false);
    expect(video.getAttribute("poster")).toBe(`/o/l/-/image/${H("b")}`);
    expect(video.getAttribute("width")).toBe("640");
    expect(video.getAttribute("height")).toBe("360");
    expect(video.closest("[data-atom]")?.className).toBe("figure-media figure-video");
    // No poster and no size known: none drawn.
    const raw = root.querySelector('video[aria-label="No poster"]') as Element;
    expect(raw.hasAttribute("poster")).toBe(false);
    expect(raw.hasAttribute("width")).toBe(false);
    const audio = root.querySelector("audio") as Element;
    expect(audio.getAttribute("src")).toBe(`/o/l/-/media/${H("d")}`);
    expect(audio.hasAttribute("controls")).toBe(true);
    expect(audio.getAttribute("aria-label")).toBe("A tone");
    // A PDF: a card with its name, type and size, Open (its page) and Download; no viewer.
    const card = root.querySelector(".figure-pdf") as Element;
    expect(card.closest("[data-atom]")).not.toBeNull();
    expect(card.querySelector(".figure-pdf-name")?.textContent).toBe("paper.pdf");
    expect(card.querySelector(".figure-pdf-meta")?.textContent).toBe("PDF document · 1.2 MB");
    const links = [...card.querySelectorAll("a")].map((a) => [
      a.textContent?.trim(),
      a.getAttribute("href"),
    ]);
    expect(links).toEqual([
      ["Open", "/o/l/docs/paper.pdf"],
      ["Download", "/o/l/-/download/docs/paper.pdf"],
    ]);
    expect(root.querySelector("embed, iframe, object")).toBeNull();
    // In running text: a link to its page, still one atom.
    const inline = root.querySelector('a[data-atom][href="/o/l/clips/demo.webm"]');
    expect(inline?.textContent).toBe("a clip");
    // In figure markup, and missing (not in `images`): a video and an image, as before.
    expect(root.querySelectorAll('video[aria-label="Grouped"]').length).toBe(1);
    expect(root.querySelector('img[alt="Missing"]')).not.toBeNull();
  });

  test("a video that fails says so; the full-screen view plays it and opens a PDF's page", async () => {
    await live(async (window) => {
      const p = prepare(stored(MEDIA), options);
      const opened: number[] = [];
      const { host } = put(Body, { prepared: p, diff: null, hideFirst: false }, (n) =>
        opened.push(n),
      );
      const enlarge = host.querySelector(
        'button[aria-label="Enlarge video: A 20-second walkthrough"]',
      ) as HTMLButtonElement;
      await act(async () => enlarge.click());
      expect(opened).toEqual([2]);
      // Audio has no Enlarge (its controls are all there is); the PDF card has none either.
      expect(host.querySelectorAll("button[aria-label^='Enlarge video']").length).toBe(3);
      const raw = host.querySelector('video[aria-label="No poster"]') as HTMLVideoElement;
      await act(async () => {
        raw.dispatchEvent(new window.Event("error"));
      });
      const broken = host.querySelector('[aria-label="This video can\'t be played: No poster"]');
      expect(broken?.hasAttribute("data-atom")).toBe(true);

      const { host: box } = put(Lightbox, {
        figures: p.figures,
        at: 2,
        view: {
          fileHref: (path) => `/o/l/${path}`,
          downloadHref: (path) => `/o/l/-/download/${path}`,
        },
        onMove: () => {},
        onClose: () => {},
      });
      const played = box.querySelector(".lightbox-figure > video") as HTMLVideoElement;
      expect(played.getAttribute("src")).toBe(`/o/l/-/media/${H("a")}`);
      expect(played.hasAttribute("controls")).toBe(true);
      expect(box.textContent).toContain("fig. 2 of 7");
      const { host: pdfBox } = put(Lightbox, {
        figures: p.figures,
        at: 5,
        view: { fileHref: (path) => `/o/l/${path}` },
        onMove: () => {},
        onClose: () => {},
      });
      const card = pdfBox.querySelector(".lightbox-figure > .figure-pdf") as HTMLElement;
      expect(card.querySelector("a")?.getAttribute("href")).toBe("/o/l/docs/paper.pdf");
      const open = [...pdfBox.querySelectorAll("a")].find((a) => a.textContent === "Open file");
      expect(open?.getAttribute("href")).toBe("/o/l/docs/paper.pdf");
    });
  });
});

describe("a new version redraws only what changed (TEMPRA-177)", () => {
  test("a block the new version leaves alone is the same DOM node, its text too", () => {
    const v1 = stored("# Title\n\nFirst para.\n\nSecond *para*.\n\n- one\n- two");
    const v2 = reconcile(
      v1,
      parseMarkdown(
        "# Title\n\nA new para.\n\nFirst para, changed.\n\nSecond *para*.\n\n- one\n- two\n- three",
      ),
    );
    const idOfText = (tree: Doc, text: string) =>
      idOf(tree.children.find((n) => docText({ ...tree, children: [n] }).text === text) as DocNode);
    const second = idOfText(v1, "Second para.");
    expect(idOfText(v2, "Second para.")).toBe(second);
    const props = new SvelteMap([["prepared", prepare(v1)]]);
    const { host } = put(Body, {
      get prepared() {
        return props.get("prepared") as ReturnType<typeof prepare>;
      },
      diff: null,
      hideFirst: false,
    });
    const before = host.querySelector(`[data-block="${second}"]`) as Element;
    const words = before.firstChild as Node;
    const item = host.querySelector("li") as Element;
    const p2 = prepare(v2);
    props.set("prepared", p2);
    flushSync();
    const after = host.querySelector(`[data-block="${second}"]`) as Element;
    expect(after === before).toBe(true);
    expect(after.firstChild === words).toBe(true);
    expect(host.querySelector("li") === item).toBe(true);
    // Moved down the text: its offset follows, and the counting holds over the whole body.
    expect(Number(after.getAttribute("data-text"))).toBe(p2.text.text.indexOf("Second para."));
    expect(host.querySelectorAll("li").length).toBe(3);
    const tbs = textblocks(host);
    expect(tbs.length).toBe(p2.text.blocks.length);
    tbs.forEach((tb, i) => {
      const b = p2.text.blocks[i];
      expect(Number(tb.getAttribute("data-text"))).toBe(b?.from ?? -1);
      expect(readText(tb)).toBe(p2.text.text.slice(b?.from, b?.to));
    });
  });
});

describe("the reader's overlays", () => {
  test("highlights, a link's card (Escape closes it), and Comment on selected text", async () => {
    const g = globalThis as Record<string, unknown>;
    const saved = { CSS: g.CSS, Highlight: g.Highlight };
    const sets = new Map<string, { ranges: Range[] }>();
    g.CSS = {
      highlights: {
        set: (name: string, h: { ranges: Range[] }) => sets.set(name, h),
        delete: (name: string) => sets.delete(name),
      },
    };
    g.Highlight = class {
      ranges: Range[];
      constructor(...ranges: Range[]) {
        this.ranges = ranges;
      }
    };
    try {
      const p = prepare(stored("Hello [link](https://e.com) world, and more text."));
      const comments: { from: number; to: number }[] = [];
      const { host } = put(Reader<string>, {
        prepared: p,
        diff: null,
        hideFirst: false,
        hover: (h) => (h.kind === "link" ? `To ${h.href}` : null),
        card: createRawSnippet((text: () => string) => ({ render: () => `<b>${text()}</b>` })),
        highlights: [{ id: "t1", from: 0, to: 5 }],
        onComment: (r) => comments.push(r),
      });
      await act();
      expect(sets.get("tempra-comment")?.ranges.map((r) => r.toString())).toEqual(["Hello"]);
      expect(sets.get("tempra-comment-active")?.ranges).toEqual([]);
      // A card over the link, describing it; Escape closes it.
      const link = host.querySelector("a") as HTMLElement;
      link.dispatchEvent(new window.PointerEvent("pointerover", { bubbles: true }));
      await act(() => new Promise((r) => setTimeout(r, 300)));
      const tip = document.querySelector(".floating.tooltip") as HTMLElement;
      expect(tip.textContent).toBe("To https://e.com");
      expect(tip.getAttribute("popover")).toBe("manual");
      expect(tip.getAttribute("role")).toBe("tooltip");
      expect(link.getAttribute("aria-describedby")).toBe(tip.id);
      expect(tip.style.getPropertyValue("--float-x")).toMatch(/^\d+px$/);
      document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      flushSync();
      expect(document.querySelector(".floating.tooltip")).toBeNull();
      expect(link.hasAttribute("aria-describedby")).toBe(false);
      // Selected text: the toolbar's Comment, then Ctrl+Alt+M.
      const prose = host.querySelector(".prose") as Element;
      const sel = document.getSelection() as Selection;
      sel.removeAllRanges();
      sel.addRange(rangeOf(prose, 0, 5) as Range);
      document.dispatchEvent(new window.Event("selectionchange"));
      await act(() => new Promise((r) => setTimeout(r, 150)));
      const button = document.querySelector(".selection-tools button") as HTMLButtonElement;
      expect(button.textContent).toBe("Comment");
      button.click();
      flushSync();
      expect(comments).toEqual([{ from: 0, to: 5 }]);
      expect(document.querySelector(".selection-tools")).toBeNull();
      sel.addRange(rangeOf(prose, 11, 16) as Range);
      document.dispatchEvent(
        new window.KeyboardEvent("keydown", { ctrlKey: true, altKey: true, code: "KeyM" }),
      );
      expect(comments).toEqual([
        { from: 0, to: 5 },
        { from: 11, to: 16 },
      ]);
    } finally {
      Object.assign(g, saved);
    }
  });
});

// Commented text has a mark beside its block (TEMPRA-223): outside the counted text, so the
// reader's counting is untouched, one per block with open threads, opening the first.
describe("comment marks beside blocks (TEMPRA-223)", () => {
  const MD =
    "# Title\n\nFirst paragraph with a quote.\n\n- one item\n- two items\n\nLast paragraph, quoted twice.";

  /** Highlights on the text of `md`: [quote, id] pairs, by where each quote starts. */
  const marksOn = (p: ReturnType<typeof prepare>, quotes: [string, string][]): Highlight[] =>
    quotes.map(([q, id]) => {
      const from = p.text.text.indexOf(q);
      return { id, from, to: from + q.length };
    });

  test("one mark per block, its count and first thread; the draft is not a thread", () => {
    const tree = stored(MD);
    const p = prepare(tree, {});
    const { host } = put(Body, { prepared: p, diff: null, hideFirst: false });
    const hs = [
      ...marksOn(p, [
        ["quoted twice", "t3"],
        ["Last paragraph", "t2"],
        ["a quote", "t1"],
        ["two items", "t4"],
      ]),
      { id: "draft", from: 2, to: 4, draft: true },
    ];
    const got = blockMarks(host, hs).map((m) => ({
      first: m.first,
      count: m.count,
      tag: m.block.tagName,
    }));
    expect(got).toEqual([
      { first: "t1", count: 1, tag: "P" },
      { first: "t4", count: 1, tag: "UL" },
      { first: "t2", count: 2, tag: "P" },
    ]);
  });

  test("placed in the gutter beside the block when it fits, else under the block's end", () => {
    const rect = (left: number, top: number, width: number, height: number) =>
      ({ left, top, right: left + width, bottom: top + height, width, height }) as DOMRect;
    const body = rect(100, 50, 600, 900);
    const block = rect(100, 250, 578, 60);
    expect(placeMark(block, body, 678, 82, 44)).toEqual({ x: 586, y: 200, end: false });
    expect(placeMark(block, body, 678, 16, 44)).toEqual({ x: 578, y: 260, end: true });
  });

  test("the reader draws them outside the text, keeps its counting, and a mark opens its thread", () => {
    for (const { file, body } of bodies().slice(0, 12)) {
      const tree = stored(body);
      const p = prepare(tree, {});
      // A thread on every textblock long enough to quote.
      const hs: Highlight[] = p.text.blocks
        .filter((b) => b.to - b.from > 4)
        .map((b, i) => ({ id: `t${i}`, from: b.from + 1, to: b.to - 1 }));
      const opened: (string | null)[] = [];
      const { host } = put(Reader, {
        prepared: p,
        diff: null,
        hideFirst: false,
        highlights: hs,
        onMark: (id: string | null) => opened.push(id),
      });
      const prose = host.querySelector(".prose") as Element;
      const layer = host.querySelector(".comment-marks");
      if (hs.length === 0) continue;
      // The layer is the body's, beside the text, never inside it.
      expect({ file, layer: layer !== null }).toEqual({ file, layer: true });
      expect(prose.contains(layer)).toBe(false);
      // The text counts as docText does, every textblock at its offset.
      const blocks = p.text.blocks;
      const tbs = textblocks(prose);
      const drawn = blocks.filter((b) =>
        tbs.some((tb) => Number(tb.getAttribute("data-text")) === b.from),
      );
      expect(tbs.length).toBe(drawn.length);
      for (const tb of tbs) {
        const at = Number(tb.getAttribute("data-text"));
        const b = blocks.find((x) => x.from === at);
        expect({ file, text: readText(tb) }).toEqual({
          file,
          text: p.text.text.slice(b?.from, b?.to),
        });
      }
      // One mark per block that holds a quote, named by its count; the first opens its thread.
      const marks = Array.from(host.querySelectorAll<HTMLButtonElement>("button.comment-mark"));
      const expected = blockMarks(prose, hs);
      expect({ file, n: marks.length }).toEqual({ file, n: expected.length });
      const one = marks[0];
      const first = expected[0];
      if (!one || !first) continue;
      expect(one.getAttribute("aria-label")).toBe(
        first.count === 1 ? "1 comment" : `${first.count} comments`,
      );
      expect(one.textContent?.trim()).toBe(String(first.count));
      one.click();
      expect(opened).toEqual([first.first]);
    }
  });

  test("no open threads, no layer", () => {
    const p = prepare(stored(MD), {});
    const { host } = put(Reader, {
      prepared: p,
      diff: null,
      hideFirst: false,
      highlights: [{ id: "draft", from: 9, to: 14, draft: true }],
      onMark: () => {},
    });
    expect(host.querySelector(".comment-marks")).toBeNull();
  });
});
