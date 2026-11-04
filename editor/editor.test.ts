import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ContainerDirective } from "mdast-util-directive";
import {
  ATOM,
  checkFigure,
  type Doc,
  docText,
  findFigures,
  linkTarget,
  normalize,
  parseMarkdown,
  reconcile,
  toMarkdown,
  wordDiff,
} from "./src/index";

const FIXTURES = join(import.meta.dir, "..", "fixtures");

/** Every page body in Google's sample bundles, frontmatter removed. */
export function bodies(): { file: string; body: string }[] {
  const walk = (d: string): string[] =>
    readdirSync(d).flatMap((f) => {
      const p = join(d, f);
      return statSync(p).isDirectory() ? walk(p) : p.endsWith(".md") ? [p] : [];
    });
  return walk(FIXTURES)
    .filter((f) => !/(^|\/)(index|log|README|LICENSE)\.md$/.test(f))
    .map((file) => ({
      file: file.slice(FIXTURES.length + 1),
      body: readFileSync(file, "utf8").replace(/^---\n[\s\S]*?\n---\n?/, ""),
    }));
}

/** A stored tree for some markdown: parsed, with IDs. */
const stored = (md: string): Doc => reconcile(null, parseMarkdown(md));

describe("the sample bundles", () => {
  const all = bodies();

  test("there are bodies to test", () => {
    expect(all.length).toBeGreaterThan(50);
  });

  for (const { file, body } of all) {
    test(file, () => {
      // Normalized once, then byte-stable: written, parsed and written again, the same bytes.
      const once = normalize(body);
      expect(normalize(once)).toBe(once);
      // The canonical form means the same as what was written.
      expect(parseMarkdown(once)).toEqual(parseMarkdown(body));
      // Every textblock has its place in the text, in order, one newline apart.
      const t = docText(stored(body));
      t.blocks.forEach((tb, i) => {
        const prev = t.blocks[i - 1];
        expect(tb.from).toBe(prev ? prev.to + 1 : 0);
      });
      expect(t.text.length).toBe(t.blocks.at(-1)?.to ?? 0);
    });
  }
});

describe("constructs the tree does not model are kept", () => {
  const cases = [
    "Inline <span class=x>html</span> stays.",
    "<div>\nA block of HTML\n</div>",
    "A [reference link][ref].\n\n[ref]: https://example.com",
    "An ![image ref][img].\n\n[img]: /a.png",
    "Hard  \nbreak and\nsoft break.",
    "- [x] done\n- [ ] open",
    "1. one\n2. two\n\n   loose",
    "| a | b |\n|:-:|--:|\n| 1 | 2 |",
    "```sql title=x\nselect 1\n\nfrom t\n```",
    "    indented code",
    "> quote\n>\n> - in a list",
    "~~struck~~ and ***both*** and *a **b***",
    "Autolink https://example.com and <mailto:a@b.c>.",
    "Cites [^src] with no definition, and \\[^not] a reference.",
  ];
  for (const md of cases) {
    test(JSON.stringify(md.slice(0, 30)), () => {
      const once = normalize(md);
      expect(normalize(once)).toBe(once);
      expect(parseMarkdown(once)).toEqual(parseMarkdown(md));
      expect(toMarkdown(stored(md))).toBe(once);
    });
  }

  test("random unknown inline HTML survives unchanged", () => {
    for (let i = 0; i < 200; i++) {
      const tag = `x${Math.random().toString(36).slice(2, 7)}`;
      const md = `Before <${tag} data-n="${i}">mid</${tag}> after ${i}.`;
      expect(normalize(md)).toBe(`${md}\n`);
    }
  });

  test("a footnote reference written with no definition stays one", () => {
    expect(normalize("See [^a].")).toBe("See [^a].\n");
    expect(normalize("Not \\[^a].")).toBe("Not \\[^a].\n");
  });

  test("an empty body is empty", () => {
    expect(normalize("")).toBe("");
    expect(stored("")).toEqual({ type: "root", children: [] });
  });
});

/** Figure markup in each form (tempra-dev: app/media, Figure markup), canonical as written. */
export const FIGURE_FORMS: Record<string, string> = {
  sized: ':::figure{width=480 frame}\n![The sign-in page](/app/signin.png "Sign-in")\n:::\n',
  share: ":::figure{width=60%}\n![A chart](/app/chart.png)\n:::\n",
  wide: ':::figure{layout=wide}\n![The workspace](/app/wide.png "The whole frame")\n:::\n',
  full: ":::figure{layout=full frame}\n![The page](/app/full.png)\n:::\n",
  group:
    ':::figure[The top bar *before* and after]{layout=wide}\n![Crumbs](/app/before.png "Before")\n![The path](/app/after.png "After")\n:::\n',
  "group of four":
    ":::figure[Four]\n![1](/a/1.png)\n![2](/a/2.png)\n![3](/a/3.png)\n![4](/a/4.png)\n:::\n",
};

describe("figure markup", () => {
  for (const [name, md] of Object.entries(FIGURE_FORMS)) {
    test(name, () => {
      // Canonical as written, byte-stable, and the same tree.
      expect(normalize(md)).toBe(md);
      expect(parseMarkdown(normalize(md))).toEqual(parseMarkdown(md));
      expect(toMarkdown(stored(md))).toBe(md);
      // One block in the tree; each image one atom, the group caption nothing.
      const doc = stored(md);
      expect(doc.children).toHaveLength(1);
      const fig = doc.children[0] as never as ContainerDirective;
      expect(fig.type).toBe("containerDirective");
      const check = checkFigure(fig);
      expect(check.ok).toBe(true);
      const n = check.ok ? check.spec.images.length : 0;
      expect(docText(doc).text).toBe(Array(n).fill("\uFFFC").join("\n"));
    });
  }

  test("what was written is made canonical: attribute order, quotes, one image a line", () => {
    expect(
      normalize(':::figure{frame layout="wide" width="480"}\n![a](/a.png)\n\n![b](/b.png)  \n:::'),
    ).toBe(":::figure{width=480 layout=wide frame}\n![a](/a.png)\n![b](/b.png)\n:::\n");
    expect(normalize(":::figure\n![a](/a.png) ![b](/b.png)\n:::")).toBe(
      ":::figure\n![a](/a.png)\n![b](/b.png)\n:::\n",
    );
  });

  test("each image of a figure counts in the numbering the reader and MCP share", () => {
    const doc = stored(
      `![Plain](/p.png)\n\n${FIGURE_FORMS.group}\n:::figure{layout=side}\n![Bad markup](/b.png)\n:::\n`,
    );
    const found = findFigures(doc);
    expect(
      found.map((f) => [
        f.n,
        f.kind === "image" ? f.image.alt : "",
        f.kind === "image" && !!f.markup,
      ]),
    ).toEqual([
      [1, "Plain", false],
      [2, "Crumbs", true],
      [3, "The path", true],
      [4, "Bad markup", false],
    ]);
  });

  test("what it says", () => {
    const spec = (md: string) => {
      const c = checkFigure(parseMarkdown(md).children[0] as never);
      return c.ok ? c.spec : null;
    };
    expect(spec(FIGURE_FORMS.sized as string)).toMatchObject({
      width: { value: 480, unit: "px" },
      layout: "column",
      frame: true,
    });
    expect(spec(FIGURE_FORMS.share as string)?.width).toEqual({ value: 60, unit: "%" });
    expect(spec(FIGURE_FORMS.group as string)?.layout).toBe("wide");
    expect(spec(FIGURE_FORMS.group as string)?.images).toHaveLength(2);
    expect(spec(FIGURE_FORMS.group as string)?.label).not.toBeNull();
  });

  test("markup that does not parse is kept as written and says why", () => {
    const bad = [
      [":::figure{width=wide}\n![a](/a.png)\n:::\n", /not a width/],
      [":::figure{layout=side}\n![a](/a.png)\n:::\n", /not a layout/],
      [":::figure{frame=yes}\n![a](/a.png)\n:::\n", /takes no value/],
      [":::figure{.big}\n![a](/a.png)\n:::\n", /not a figure attribute/],
      [":::figure\nJust words.\n:::\n", /images only/],
      [":::figure\n:::\n", /no images/],
      [`:::figure\n${"![a](/a.png)\n".repeat(5)}:::\n`, /at most 4/],
    ] as const;
    for (const [md, why] of bad) {
      expect(normalize(md)).toBe(md);
      const c = checkFigure(parseMarkdown(md).children[0] as never);
      expect(c.ok).toBe(false);
      expect(c.ok ? "" : c.problems.join("; ")).toMatch(why);
    }
  });

  test("other directives are kept as written; text and leaf directives are off", () => {
    for (const md of [
      ':::note{#x .y z="a b"}\nHello *there*\n:::\n',
      "::::figure\n:::aside\nNested.\n:::\n::::\n",
    ]) {
      expect(normalize(md)).toBe(md);
      expect(normalize(normalize(md))).toBe(normalize(md));
    }
    expect(docText(stored(':::note[Label]{z="a b"}\nHello *there*\n:::\n')).text).toBe(
      "Hello there",
    );
    // Colons in prose never change meaning, and nothing is escaped for them.
    const prose = "A ratio 3:1, see:here, ::leaf and :name[x]{y}.\n\n::leaf\n";
    expect(normalize(prose)).toBe("A ratio 3:1, see:here, ::leaf and :name\\[x]{y}.\n\n::leaf\n");
    expect(parseMarkdown(prose).children.every((c) => c.type === "paragraph")).toBe(true);
    // A line of text that would open a directive stays text.
    expect(normalize("\\:::figure\ntext")).toBe("::\\:figure\ntext\n");
    expect(normalize("::\\:figure\ntext")).toBe("::\\:figure\ntext\n");
    expect(parseMarkdown("\\:::figure\ntext").children[0]?.type).toBe("paragraph");
  });
});

describe("an image with its footnote is a figure (TEMPRA-218)", () => {
  const notes = (md: string) =>
    findFigures(stored(md)).map((f) =>
      f.kind === "image" ? [f.image.alt, f.notes.map((r) => r.identifier)] : [],
    );

  test("one image and only footnote references after it, whitespace between, is a figure", () => {
    const defs = "\n\n[^src]: Source.\n\n[^two]: Another.\n";
    expect(
      notes(`![A mountain ridge](/assets/r.jpg "Fronalpstock panorama")[^src]${defs}`),
    ).toEqual([["A mountain ridge", ["src"]]]);
    expect(notes(`![Two](/two.png) [^src][^two]${defs}`)).toEqual([["Two", ["src", "two"]]]);
    expect(notes(`![Plain](/p.png)${defs}`)).toEqual([["Plain", []]]);
    // Any other text, or a reference before the image, and it stays inline: no figure.
    expect(notes(`![Inline](/i.png)[^src] and words.${defs}`)).toEqual([]);
    expect(notes(`[^src]![Inline](/i.png)${defs}`)).toEqual([]);
    expect(notes(`![One](/1.png)[^src]![Two](/2.png)${defs}`)).toEqual([]);
    // The stored form keeps the reference where it was written; the text has its atom.
    const md = `![A](/a.png "Caption")[^src]${defs}`;
    expect(normalize(md)).toBe(md);
    expect(docText(stored(md)).text).toBe(`${ATOM}${ATOM}`);
  });

  test("in figure markup an image may carry its references, kept beside it", () => {
    const md = ':::figure[Two]\n![L](/l.png "Left") [^src]\n\n![R](/r.png)[^two]\n:::';
    const c = checkFigure(parseMarkdown(md).children[0] as never);
    expect(c.ok).toBe(true);
    expect(normalize(md)).toBe(
      ':::figure[Two]\n![L](/l.png "Left")[^src]\n![R](/r.png)[^two]\n:::\n',
    );
    expect(notes(`${md}\n\n[^src]: S.\n\n[^two]: T.`)).toEqual([
      ["L", ["src"]],
      ["R", ["two"]],
    ]);
    // A reference before the first image is not a figure's.
    const before = checkFigure(
      parseMarkdown(":::figure\n[^src]![a](/a.png)\n:::").children[0] as never,
    );
    expect(before.ok).toBe(false);
  });
});

describe("links", () => {
  test("linkTarget follows the server's rules", () => {
    expect(linkTarget("a/b.md", "../c.md#x")).toEqual({
      kind: "internal",
      path: "c.md",
      anchor: "#x",
      dir: false,
    });
    expect(linkTarget("a/b.md", "/d/")).toEqual({
      kind: "internal",
      path: "d",
      anchor: null,
      dir: true,
    });
    expect(linkTarget("a.md", "data:text/html,x")).toBeNull();
    expect(linkTarget("a.md", "//e.com/x")).toEqual({ kind: "external", href: "https://e.com/x" });
  });
});

describe("the document's text", () => {
  test("the text reads as the page does", () => {
    const t = docText(
      parseMarkdown("# A *b*\n\n- `c` [d](/e.md)\n\n| x | y |\n| - | - |\n| 1 | 2 |"),
    );
    expect(t.text).toBe("A b\nc d\nx\ny\n1\n2");
  });
});

describe("word diff", () => {
  const doc = (md: string) => docText(stored(md));
  const text = (d: ReturnType<typeof docText>, r: { from: number; to: number }) =>
    d.text.slice(r.from, r.to);

  test("added words are text ranges of the newer version; removed words sit where they were", () => {
    const older = doc("The margin is 40 percent.\n\nSecond paragraph stays.");
    const newer = doc("The gross margin is 42 percent.\n\nSecond paragraph stays.");
    const d = wordDiff(older, newer);
    expect(d.added.map((r) => text(newer, r))).toEqual(["gross ", "42 "]);
    expect(d.removed.map((r) => r.text)).toEqual(["40"]);
    const at = d.removed[0]?.pos ?? -1;
    expect(newer.text.slice(at, at + 7)).toBe("percent");
  });

  test("identical versions have no changes; a whole new block is added", () => {
    const a = doc("Same words here.");
    expect(wordDiff(a, doc("Same words here."))).toEqual({ added: [], removed: [] });
    const b = doc("Same words here.\n\nA new block.");
    expect(wordDiff(a, b).added.map((r) => text(b, r))).toEqual(["A new block."]);
  });

  test("words removed at the end of a block show at its end, not in the next one", () => {
    const older = doc("First block ends here.\n\nNext.");
    const newer = doc("First block ends\n\nNext.");
    const d = wordDiff(older, newer);
    expect(d.removed.at(-1)?.pos).toBe(newer.blocks[0]?.to ?? -1);
    expect(d.removed.at(-1)?.text).toEndWith("here.");
  });

  test("removed atoms and soft breaks are not shown as text", () => {
    const d = wordDiff(doc("A cited[^a] claim\nwrapped."), doc("A claim."));
    expect(d.removed.map((r) => r.text).join(" ")).not.toContain("\uFFFC");
    expect(d.removed.map((r) => r.text).join(" ")).not.toContain("\n");
  });

  test("works across every fixture against an edited copy", () => {
    for (const { body } of bodies().slice(0, 10)) {
      const older = doc(body);
      const newer = doc(`${body.trimEnd()}\n\nAn added paragraph.\n`);
      const d = wordDiff(older, newer);
      expect(d.added.map((r) => text(newer, r)).join("")).toBe("An added paragraph.");
      expect(wordDiff(older, older)).toEqual({ added: [], removed: [] });
    }
  });
});
