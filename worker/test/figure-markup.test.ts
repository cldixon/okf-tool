/** Figure lint (TEMPRA-161; tempra-dev: app/media, Figure markup): on write and import, never a refusal. */
import { describe, expect, test } from "bun:test";
import { parseMarkdown, reconcile } from "@tempra/editor/doc";
import { figureLint } from "../src/format/figure-lint";
import { LibraryStore, type RequestContext } from "../src/store/store";
import { bunSqlHandle } from "./sqlite";

let n = 0;
const ctx = (): RequestContext => ({ actor: "claude-code/test", request_id: `req-${++n}` });
/** The figure markup lint (image lint, TEMPRA-159, is tested on its own). */
const codes = (lint: { code: string }[]) =>
  lint.map((l) => l.code).filter((c) => c.startsWith("figure_"));
const md = (body: string) =>
  `---\ntype: Memo\ndescription: A test page.\nstatus: stable\n---\n${body}\n`;

const GOOD = [
  ":::figure{width=480 frame}\n![a](/a.png)\n:::",
  ":::figure{width=60% layout=full}\n![a](/a.png)\n:::",
  ':::figure[Before and after]{layout=wide}\n![a](/a.png "Before")\n![b](/b.png "After")\n:::',
  ":::note\nNot a figure: another directive is kept as written.\n:::",
  "![A plain image needs nothing](/a.png)",
];

const BAD: [string, RegExp][] = [
  [":::figure{width=huge}\n![a](/a.png)\n:::", /width=huge is not a width/],
  [":::figure{width=0}\n![a](/a.png)\n:::", /not a width/],
  [":::figure{width=120%}\n![a](/a.png)\n:::", /not a width/],
  [":::figure{layout=left}\n![a](/a.png)\n:::", /layout=left is not a layout/],
  [":::figure{frame=thin}\n![a](/a.png)\n:::", /frame takes no value/],
  [":::figure{size=2}\n![a](/a.png)\n:::", /size is not a figure attribute/],
  [":::figure\nSome words.\n:::", /images only/],
  [":::figure[Nothing]\n:::", /no images/],
  [`:::figure\n${"![a](/a.png)\n".repeat(5)}:::`, /5 images; a figure holds at most 4/],
];

describe("figure lint (TEMPRA-161)", () => {
  test("well-formed figures, other directives and plain images are not linted", () => {
    for (const body of GOOD) expect(figureLint(reconcile(null, parseMarkdown(body)))).toEqual([]);
  });

  test("markup that does not parse is figure_invalid, naming its block and the problem", () => {
    for (const [body, why] of BAD) {
      const doc = reconcile(null, parseMarkdown(`Intro.\n\n${body}`));
      const [w, ...rest] = figureLint(doc);
      expect(rest).toEqual([]);
      expect(w?.code).toBe("figure_invalid");
      expect(w?.block).toBe((doc.children[1] as { id?: string }).id);
      expect(w?.message).toMatch(why);
    }
  });

  test("a write lands with the lint and keeps the markup as written; a fix clears it; import lints too", () => {
    const broken = ":::figure{layout=side}\n![a](https://example.com/a.png)\n:::";
    const s = new LibraryStore(bunSqlHandle());
    const res = s.apply(ctx(), [{ op: "write", path: "f.md", content: md(broken) }]);
    expect(codes(res.results[0]?.lint ?? [])).toEqual(["figure_invalid"]);
    const v = s.read("f");
    expect(v.kind === "page" && codes(v.lint)).toEqual(["figure_invalid"]);
    expect(v.kind === "page" && v.markdown).toContain(`${broken}\n`);
    expect(s.work({ kind: "lint" }).items.map((i) => i.path)).toEqual(["f.md"]);
    const fixed = s.apply(ctx(), [
      {
        op: "write",
        path: "f.md",
        content: md(":::figure{layout=wide}\n![a](https://example.com/a.png)\n:::"),
        if_match: v.kind === "page" ? v.hash : "",
      },
    ]);
    expect(codes(fixed.results[0]?.lint ?? [])).toEqual([]);
    const imported = s.import(ctx(), [{ path: "g.md", markdown: md(broken) }]);
    expect(imported.warnings.flatMap((w) => codes(w.lint))).toContain("figure_invalid");
  });
});
