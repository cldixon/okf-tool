import { describe, expect, test } from "bun:test";
import { normalize, parseMarkdown } from "@tempra/editor/doc";
import { scanDoc } from "../src/format/markdown";
import {
  buildRecord,
  jsonEqual,
  parsePage,
  renderPage,
  serializeRecord,
  splitFrontmatter,
} from "../src/format/page";
import { isPagePath, relativePath, resolveLinkPath } from "../src/format/paths";
import { trustTier } from "../src/format/trust";
import { BUNDLES, loadBundle, text } from "./fixtures";

const opts = { mode: "import" as const, actor: "human:test", now: "2026-09-29T00:00:00Z" };

describe("the format module round-trips the sample bundles in memory", () => {
  for (const bundle of BUNDLES) {
    test(bundle, () => {
      const files = loadBundle(bundle).filter((f) => isPagePath(f.path));
      expect(files.length).toBeGreaterThan(0);
      for (const f of files) {
        const md = text(f.bytes);
        const parsed = parsePage(md);
        const built = buildRecord(parsed, { ...opts, path: f.path });
        const rendered = renderPage(built.record, { verified: built.verified });
        const again = parsePage(rendered);
        // Round-trip is by meaning: same fields and values; rendering fixes the key order.
        expect(
          jsonEqual(Object.fromEntries(again.entries), Object.fromEntries(parsed.entries)),
        ).toBe(true);
        expect(jsonEqual(again.generated, parsed.generated)).toBe(true);
        expect(again.verified).toEqual(parsed.verified);
        // The body comes back normalized: written once in the canonical form.
        expect(again.body).toBe(normalize(parsed.body));
        expect(built.lint.filter((l) => l.code === "missing_type")).toEqual([]);
      }
    });
  }
});

describe("parse", () => {
  test("splits frontmatter", () => {
    expect(splitFrontmatter("---\ntype: A\n---\n\nbody")).toEqual({
      fm: "type: A",
      body: "\nbody",
    });
    expect(splitFrontmatter("no fm")).toEqual({ fm: null, body: "no fm" });
    expect(splitFrontmatter("---\n---\nx")).toEqual({ fm: "", body: "x" });
  });

  test("lints and ignores server-owned keys on ordinary writes", () => {
    const md =
      "---\ntype: Metric\nstatus: bogus\ngenerated: { by: me/1, at: 2026-01-01T00:00:00Z }\nverified: { by: human:x, at: 2026-01-01T00:00:00 }\n---\nA claim.[^s1]\n\n[^s1]: note\n";
    const built = buildRecord(parsePage(md), {
      mode: "write",
      actor: "claude-code/test",
      now: "2026-09-29T00:00:00Z",
      path: "a.md",
    });
    expect(built.record.generated).toEqual({ by: "claude-code/test", at: "2026-09-29T00:00:00Z" });
    const codes = built.lint.map((l) => l.code).sort();
    expect(codes).toEqual(["footnote_unmatched", "invalid_status", "missing_description"]);
    // Ignored server-owned fields are notices for the writer, not lint left on the page.
    expect(built.notices.map((l) => l.code).sort()).toEqual([
      "generated_ignored",
      "verified_ignored",
    ]);
  });

  test("keeps unparseable frontmatter verbatim", () => {
    const md = "---\ntype: [unclosed\n---\nbody\n";
    const built = buildRecord(parsePage(md), { ...opts, path: "a.md" });
    expect(built.record.raw_fm).toBe("type: [unclosed");
    expect(renderPage(built.record, { verified: [] })).toBe(md);
  });

  test("migrates v0.1 timestamp and citations", () => {
    const md =
      "---\ntype: Metric\ntimestamp: '2026-05-28T22:53:05+00:00'\n---\n\n# Definition\nX\n\n# Citations\n- https://a.example/x\n- [B](https://b.example)\n";
    const built = buildRecord(parsePage(md), { ...opts, path: "a.md" });
    expect(built.record.generated).toEqual({ by: "human:test", at: "2026-05-28T22:53:05+00:00" });
    expect(built.record.fm).toEqual([
      ["type", "Metric"],
      [
        "sources",
        [{ resource: "https://a.example/x" }, { resource: "https://b.example", title: "B" }],
      ],
    ]);
    expect(built.record.body).toBe("# Definition\n\nX\n");
  });

  test("record serialization is stable: the same content again is the same record", () => {
    const md = "---\ntype: A\n---\nx";
    const a = buildRecord(parsePage(md), { ...opts, path: "a.md" });
    const b = buildRecord(parsePage(md), { ...opts, path: "a.md", prev: a.record.doc });
    expect(serializeRecord(a.record)).toBe(serializeRecord(b.record));
  });
});

describe("links", () => {
  test("finds internal links with their written form and skips code", () => {
    const body = [
      "See [a](./a.md), [b](../x/b.md#h), [c](/t/c.md) and [ext](https://e.com).",
      "`[no](skip.md)`",
      "```",
      "[no](skip2.md)",
      "```",
      "![img](pic.png) [ref][r] [^foot]",
      "",
      "[r]: <d e.md>",
      "[^foot]: text",
    ].join("\n");
    const scan = scanDoc(parseMarkdown(body), "dir/sub/me.md");
    expect(scan.links.map((l) => [l.at, l.raw, l.path, l.anchor, l.form])).toEqual([
      [0, "./a.md", "dir/sub/a.md", null, "relative"],
      [1, "../x/b.md#h", "dir/x/b.md", "#h", "relative"],
      [2, "/t/c.md", "t/c.md", null, "absolute"],
      [4, "pic.png", "dir/sub/pic.png", null, "relative"],
      [5, "d e.md", "dir/sub/d e.md", null, "relative"],
    ]);
    expect(scan.footnoteRefs).toEqual(["foot"]);
  });

  test("counts every footnote reference, with or without a definition, outside code", () => {
    const body = [
      "One.[^a] Two.[^a] Three.[^b] Escaped \\[^c].",
      "`[^d]`",
      "```",
      "[^e]",
      "```",
      "",
      "[^a]: defined",
      "[^z]: defined but unused",
    ].join("\n");
    const scan = scanDoc(parseMarkdown(body), "x.md");
    expect(scan.footnoteRefs).toEqual(["a", "b"]);
    expect([...scan.footnoteCounts]).toEqual([
      ["a", 2],
      ["b", 1],
    ]);
    expect(scan.footnoteDefs).toEqual(["a", "z"]);
  });

  test("lints undefined footnotes and plain-date timestamps", () => {
    const built = buildRecord(
      parsePage(
        "---\ntype: Note\nstale_after: 2026-12-31\nsources:\n  - { id: a, resource: https://e.com }\n---\nClaim.[^a] Other.[^b]\n\n[^b]: b\n",
      ),
      { ...opts, mode: "write", path: "x.md" },
    );
    const lint = built.lint.map((l) => [l.code, l.message]);
    // A generic type and an unset status are the writer's call (tempra-dev: decisions/pages-not-okf).
    expect(lint.map(([c]) => c)).toEqual([
      "missing_description",
      "timestamp_offset",
      "footnote_undefined",
      "footnote_unmatched",
    ]);
    expect(lint[1]?.[1]).toContain("2026-12-31T00:00:00Z; a plain date is not enough");
    expect(lint[2]?.[1]).toContain("[^a]");
  });

  test("path helpers", () => {
    expect(resolveLinkPath("a/b/c.md", "../d.md")).toBe("a/d.md");
    expect(resolveLinkPath("a/b/c.md", "/x.md")).toBe("x.md");
    expect(relativePath("a/b/c.md", "a/d.md")).toBe("../d.md");
    expect(relativePath("a/b/c.md", "a/b/e.md")).toBe("e.md");
    expect(relativePath("c.md", "x/y.md")).toBe("x/y.md");
  });
});

describe("trust", () => {
  const gen = { by: "a/1", at: "2026-06-01T00:00:00Z" };
  test("tiers", () => {
    expect(trustTier(gen, [])).toBe("unverified");
    expect(trustTier(gen, [{ by: "process:n", at: "2026-06-02T00:00:00Z" }])).toBe(
      "machine-confirmed",
    );
    expect(trustTier(gen, [{ by: "human:x", at: "2026-06-02T00:00:00Z" }])).toBe("human-reviewed");
    // A human verification lapses when the content is regenerated after it.
    expect(trustTier(gen, [{ by: "human:x", at: "2026-05-01T00:00:00Z" }])).toBe("unverified");
  });
});
