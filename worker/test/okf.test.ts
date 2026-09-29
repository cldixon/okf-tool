import { describe, expect, test } from "bun:test";
import {
  buildRecord,
  jsonEqual,
  parseConcept,
  renderConcept,
  serializeRecord,
  splitFrontmatter,
} from "../src/okf/concept";
import { scanBody } from "../src/okf/markdown";
import { isConceptPath, relativePath, resolveLinkPath } from "../src/okf/paths";
import { trustTier } from "../src/okf/trust";
import { BUNDLES, loadBundle, text } from "./fixtures";

const opts = { mode: "import" as const, actor: "human:test", now: "2026-09-29T00:00:00Z" };

describe("OKF module round-trips the sample bundles in memory", () => {
  for (const bundle of BUNDLES) {
    test(bundle, () => {
      const files = loadBundle(bundle).filter((f) => isConceptPath(f.path));
      expect(files.length).toBeGreaterThan(0);
      for (const f of files) {
        const md = text(f.bytes);
        const parsed = parseConcept(md);
        const built = buildRecord(parsed, { ...opts, path: f.path });
        const rendered = renderConcept(built.record, { verified: built.verified });
        const again = parseConcept(rendered);
        // Round-trip is by meaning: same fields and values; rendering fixes the key order.
        expect(
          jsonEqual(Object.fromEntries(again.entries), Object.fromEntries(parsed.entries)),
        ).toBe(true);
        expect(jsonEqual(again.generated, parsed.generated)).toBe(true);
        expect(again.verified).toEqual(parsed.verified);
        expect(again.body).toBe(parsed.body);
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
    const built = buildRecord(parseConcept(md), {
      mode: "write",
      actor: "claude-code/test",
      now: "2026-09-29T00:00:00Z",
      path: "a.md",
    });
    expect(built.record.generated).toEqual({ by: "claude-code/test", at: "2026-09-29T00:00:00Z" });
    const codes = built.lint.map((l) => l.code).sort();
    expect(codes).toEqual([
      "footnote_unmatched",
      "generated_ignored",
      "invalid_status",
      "verified_bare_mapping",
      "verified_ignored",
    ]);
  });

  test("keeps unparseable frontmatter verbatim", () => {
    const md = "---\ntype: [unclosed\n---\nbody\n";
    const built = buildRecord(parseConcept(md), { ...opts, path: "a.md" });
    expect(built.record.raw_fm).toBe("type: [unclosed");
    expect(renderConcept(built.record, { verified: [] })).toBe(md);
  });

  test("migrates v0.1 timestamp and citations", () => {
    const md =
      "---\ntype: Metric\ntimestamp: '2026-05-28T22:53:05+00:00'\n---\n\n# Definition\nX\n\n# Citations\n- https://a.example/x\n- [B](https://b.example)\n";
    const built = buildRecord(parseConcept(md), { ...opts, path: "a.md" });
    expect(built.record.generated).toEqual({ by: "human:test", at: "2026-05-28T22:53:05+00:00" });
    expect(built.record.fm).toEqual([
      ["type", "Metric"],
      [
        "sources",
        [{ resource: "https://a.example/x" }, { resource: "https://b.example", title: "B" }],
      ],
    ]);
    expect(built.record.body).toBe("\n# Definition\nX\n\n");
  });

  test("record serialization is stable", () => {
    const md = "---\ntype: A\n---\nx";
    const a = buildRecord(parseConcept(md), { ...opts, path: "a.md" });
    const b = buildRecord(parseConcept(md), { ...opts, path: "a.md" });
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
    const scan = scanBody(body, "dir/sub/me.md");
    expect(scan.links.map((l) => [l.raw, l.path, l.anchor, l.form])).toEqual([
      ["./a.md", "dir/sub/a.md", null, "relative"],
      ["../x/b.md#h", "dir/x/b.md", "#h", "relative"],
      ["/t/c.md", "t/c.md", null, "absolute"],
      ["pic.png", "dir/sub/pic.png", null, "relative"],
      ["<d e.md>", "dir/sub/d e.md", null, "relative"],
    ]);
    for (const l of scan.links) expect(body.slice(l.start, l.end)).toBe(l.raw);
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
    const scan = scanBody(body, "x.md");
    expect(scan.footnoteRefs).toEqual(["a", "b"]);
    expect([...scan.footnoteCounts]).toEqual([
      ["a", 2],
      ["b", 1],
    ]);
    expect(scan.footnoteDefs).toEqual(["a", "z"]);
  });

  test("lints undefined footnotes and plain-date timestamps", () => {
    const built = buildRecord(
      parseConcept(
        "---\ntype: Note\nstale_after: 2026-12-31\nsources:\n  - { id: a, resource: https://e.com }\n---\nClaim.[^a] Other.[^b]\n\n[^b]: b\n",
      ),
      { ...opts, mode: "write", path: "x.md" },
    );
    const lint = built.lint.map((l) => [l.code, l.message]);
    expect(lint.map(([c]) => c)).toEqual([
      "timestamp_offset",
      "footnote_undefined",
      "footnote_unmatched",
    ]);
    expect(lint[0]?.[1]).toContain("2026-12-31T00:00:00Z; a plain date is not enough");
    expect(lint[1]?.[1]).toContain("[^a]");
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
