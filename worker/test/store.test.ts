import { describe, expect, test } from "bun:test";
import { normalize } from "@tempra/editor/doc";
import { sha256Hex } from "../src/format/hash";
import { jsonEqual, parsePage, splitFrontmatter } from "../src/format/page";
import { isPagePath } from "../src/format/paths";
import { StoreError } from "../src/store/errors";
import {
  type FileView,
  type ImportFile,
  LibraryStore,
  type RequestContext,
} from "../src/store/store";
import { BUNDLES, loadBundle, text } from "./fixtures";
import { bunSqlHandle } from "./sqlite";

/** A page's body as `read` renders it: its markdown without the frontmatter. */
const bodyOf = (v: { kind: string; markdown?: string }) => splitFrontmatter(v.markdown ?? "").body;

let n = 0;
const ctx = (actor = "claude-code/test", note?: string): RequestContext => ({
  actor,
  request_id: `req-${++n}`,
  note,
});

function newStore() {
  let t = Date.parse("2026-09-29T12:00:00Z");
  const now = () => {
    t += 1000;
    return new Date(t);
  };
  return new LibraryStore(bunSqlHandle(), { now });
}

function errorOf(fn: () => unknown): StoreError {
  try {
    fn();
  } catch (e) {
    if (e instanceof StoreError) return e;
    throw e;
  }
  throw new Error("expected an StoreError");
}

function pageView(v: FileView) {
  if (v.kind !== "page") throw new Error(`expected a page, got ${v.kind}`);
  return v;
}

/** A page as an agent should write it: a specific type, a description and a status. */
/** Lint without `relative_link`, for tests about relative links themselves. */
const withoutRelative = <T extends { code: string }>(lint: T[]) =>
  lint.filter((l) => l.code !== "relative_link");

const md = (type: string, body: string, extra = "") => {
  const fill = [
    /^description:/m.test(extra) ? "" : "description: A test page.\n",
    /^status:/m.test(extra) ? "" : "status: stable\n",
  ].join("");
  return `---\ntype: ${type}\n${fill}${extra}---\n${body}`;
};

describe("write path", () => {
  test("create, conditional replace, stamping and events", () => {
    const s = newStore();
    const r1 = s.apply(ctx("agent/1", "first"), [
      {
        op: "write",
        path: "a.md",
        content: md("Memo", "Hello\n", "generated: { by: x/1, at: 2020-01-01T00:00:00Z }\n"),
      },
    ]);
    const res = r1.results[0];
    expect(res?.seq).toBe(1);
    expect(res?.lint).toEqual([]);
    expect(res?.notices?.map((l) => l.code)).toEqual(["generated_ignored"]);
    const view = s.read("a");
    if (view.kind !== "page") throw new Error("not a page");
    expect(view.frontmatter.generated).toEqual({ by: "agent/1", at: "2026-09-29T12:00:01Z" });

    // Replace without If-Match fails with the current hash.
    const e = errorOf(() =>
      s.apply(ctx(), [{ op: "write", path: "a.md", content: md("Memo", "x") }]),
    );
    expect(e.status).toBe(409);
    expect(e.extra.current_hash).toBe(view.hash);
    // Stale If-Match fails; the right one succeeds.
    expect(
      errorOf(() => s.apply(ctx(), [{ op: "write", path: "a.md", content: "x", if_match: "nope" }]))
        .status,
    ).toBe(412);
    const r2 = s.apply(ctx(), [
      { op: "write", path: "a.md", content: md("Memo", "Bye\n"), if_match: view.hash },
    ]);
    expect(r2.results[0]?.hash).not.toBe(view.hash);
    const ev = s.events().events;
    expect(ev.map((x) => [x.seq, x.op, x.prev_hash === null])).toEqual([
      [1, "put", true],
      [2, "put", false],
    ]);
    expect(ev[0]?.meta).toEqual({ note: "first" });
  });

  test("reserved paths and the size cap are refused", () => {
    const s = new LibraryStore(bunSqlHandle(), { pageCap: 200 });
    expect(
      errorOf(() => s.apply(ctx(), [{ op: "write", path: "x/index.md", content: "x" }])).status,
    ).toBe(405);
    const big = errorOf(() =>
      s.apply(ctx(), [{ op: "write", path: "big.md", content: md("Memo", "y".repeat(500)) }]),
    );
    expect([big.status, big.code]).toEqual([413, "page_too_large"]);
    expect(s.headSeq()).toBe(0);
  });

  test("a failing op rolls back the whole request", () => {
    const s = newStore();
    const e = errorOf(() =>
      s.apply(ctx(), [
        { op: "write", path: "a.md", content: md("Memo", "a") },
        { op: "delete", path: "missing.md", if_match: "x" },
      ]),
    );
    expect(e.status).toBe(404);
    expect(s.headSeq()).toBe(0);
    expect(s.tree().entries).toEqual([]);
  });

  test("edit applies find-and-replace on the rendered document", () => {
    const s = newStore();
    s.apply(ctx(), [{ op: "write", path: "a.md", content: md("Sketch", "one two\n") }]);
    s.apply(ctx(), [
      {
        op: "edit",
        path: "a.md",
        edits: [
          { old: "type: Sketch", new: "type: Memo" },
          { old: "two", new: "2" },
        ],
      },
    ]);
    const v = s.read("a.md");
    if (v.kind !== "page") throw new Error();
    expect(v.frontmatter.type).toBe("Memo");
    expect(bodyOf(v)).toBe("one 2\n");
    const miss = errorOf(() =>
      s.apply(ctx(), [{ op: "edit", path: "a.md", edits: [{ old: "zzz", new: "" }] }]),
    );
    expect([miss.status, miss.code]).toEqual([409, "edit_mismatch"]);
    expect(typeof miss.extra.current).toBe("string");
  });

  test("server-owned keys echoed back produce no lint; changed ones do", () => {
    const s = newStore();
    s.apply(ctx(), [{ op: "write", path: "a.md", content: md("Memo", "x\n") }]);
    const v = s.read("a.md");
    if (v.kind !== "page") throw new Error();
    const echoed = s.apply(ctx(), [
      { op: "write", path: "a.md", content: v.markdown, if_match: v.hash },
    ]);
    expect(echoed.results[0]?.lint).toEqual([]);
    const v2 = pageView(s.read("a.md"));
    const changed = v2.markdown.replace(
      /generated: \{[^}]*\}/,
      "generated: { by: me/1, at: 2020-01-01T00:00:00Z }",
    );
    const r = s.apply(ctx(), [{ op: "write", path: "a.md", content: changed, if_match: v2.hash }]);
    expect(r.results[0]?.lint).toEqual([]);
    expect(r.results[0]?.notices?.map((l) => l.code)).toEqual(["generated_ignored"]);
    // Ignored fields are reported with the write only: nothing is left to fix on the page.
    expect(pageView(s.read("a.md")).lint).toEqual([]);
    expect(s.work({ kind: "broken_link" }).items).toEqual([]);
  });
});

describe("links", () => {
  test("links survive moves of either end and render in their written form", () => {
    const s = newStore();
    s.apply(ctx(), [
      {
        op: "write",
        path: "a/one.md",
        content: md("Memo", "See [two](./two.md), [abs](/a/two.md#x) and [gone](missing.md).\n"),
      },
      { op: "write", path: "a/two.md", content: md("Memo", "Back to [one](one.md).\n") },
    ]);
    const lint = s.read("a/one.md");
    if (lint.kind !== "page") throw new Error();
    expect(withoutRelative(lint.lint).map((l) => [l.code, l.target])).toEqual([
      ["broken_link", "a/missing.md"],
      ["missing_heading", "a/two.md"],
    ]);
    expect(bodyOf(lint)).toContain("[two](./two.md)");

    s.apply(ctx(), [{ op: "move", path: "a/two.md", to: "b/deep/two.md" }]);
    const one = s.read("a/one.md");
    if (one.kind !== "page") throw new Error();
    expect(bodyOf(one)).toBe(
      "See [two](../b/deep/two.md), [abs](/b/deep/two.md#x) and [gone](missing.md).\n",
    );
    const two = s.read("b/deep/two.md");
    if (two.kind !== "page") throw new Error();
    expect(bodyOf(two)).toBe("Back to [one](../../a/one.md).\n");

    // Reading as of before the move renders the links as they were then.
    const old = s.read("a/one.md", { at: 1 });
    if (old.kind !== "page") throw new Error();
    expect(bodyOf(old)).toContain("[two](./two.md)");

    // Creating the missing target heals the broken link.
    s.apply(ctx(), [{ op: "write", path: "a/missing.md", content: md("Memo", "now here\n") }]);
    expect(s.links("a/one.md").broken).toEqual([]);
    expect(s.links("a/missing.md").inbound.map((l) => l.path)).toEqual(["a/one.md"]);
  });

  test("directory move is one request with one event per file", () => {
    const s = newStore();
    s.apply(ctx(), [
      { op: "write", path: "d/x.md", content: md("Memo", "[y](y.md)") },
      { op: "write", path: "d/y.md", content: md("Memo", "[out](/top.md)") },
      { op: "write", path: "top.md", content: md("Memo", "[x](d/x.md)") },
    ]);
    const r = s.apply(ctx(), [{ op: "move", path: "d", to: "e/f" }]);
    expect(s.request(r.request_id).events.map((e) => [e.op, e.meta?.from_path, e.path])).toEqual([
      ["move", "d/x.md", "e/f/x.md"],
      ["move", "d/y.md", "e/f/y.md"],
    ]);
    const top = s.read("top.md");
    if (top.kind !== "page") throw new Error();
    expect(bodyOf(top)).toBe("[x](e/f/x.md)\n");
    // Collisions fail the whole move.
    s.apply(ctx(), [{ op: "write", path: "g/x.md", content: md("Memo", "") }]);
    expect(errorOf(() => s.apply(ctx(), [{ op: "move", path: "e/f", to: "g" }])).status).toBe(409);
  });
});

describe("ledger", () => {
  test("revert a path and a request, forward-only", () => {
    const s = newStore();
    s.apply(ctx(), [{ op: "write", path: "a.md", content: md("Memo", "v1\n") }]);
    const h1 = s.read("a.md").kind === "page" ? (s.read("a.md") as { hash: string }).hash : "";
    const r2 = s.apply(ctx(), [
      { op: "write", path: "a.md", content: md("Memo", "v2\n"), if_match: h1 },
    ]);
    const rv = s.revert(ctx("human:me"), { path: "a.md", to_seq: 1 });
    expect(rv.results[0]?.hash).toBe(h1);
    const v = s.read("a.md");
    if (v.kind !== "page") throw new Error();
    expect(bodyOf(v)).toBe("v1\n");
    expect(v.frontmatter.generated).toEqual({ by: "claude-code/test", at: "2026-09-29T12:00:01Z" });

    // Revert the request that wrote v2: back to v1 is already true, so nothing to do.
    expect(errorOf(() => s.revert(ctx(), { request_id: r2.request_id })).code).toBe(
      "nothing_to_revert",
    );

    // A request that creates, moves and deletes is undone by reverting it.
    s.apply(ctx(), [{ op: "write", path: "b.md", content: md("Memo", "b\n") }]);
    const hb = (s.read("b.md") as { hash: string }).hash;
    const big = s.apply(ctx(), [
      { op: "write", path: "c.md", content: md("Memo", "c\n") },
      { op: "move", path: "a.md", to: "moved/a.md" },
      { op: "delete", path: "b.md", if_match: hb },
    ]);
    s.revert(ctx(), { request_id: big.request_id });
    expect(s.tree().entries.map((e) => e.path)).toEqual(["a.md", "b.md"]);
    expect(s.events().events.map((e) => e.op)).toEqual([
      "put",
      "put",
      "revert",
      "put",
      "put",
      "move",
      "delete",
      "revert",
      "move",
      "revert",
    ]);
  });

  test("snapshots, requests, history and log", () => {
    const s = newStore();
    s.apply(ctx("agent/1", "create"), [{ op: "write", path: "t/a.md", content: md("Memo", "a") }]);
    const h = (s.read("t/a.md") as { hash: string }).hash;
    s.apply(ctx("agent/2", "rename"), [{ op: "move", path: "t/a.md", to: "t/b.md" }]);
    s.apply(ctx("agent/2"), [{ op: "delete", path: "t/b.md", if_match: h }]);
    expect(s.tree({ at: 1 }).entries.map((e) => e.path)).toEqual(["t/a.md"]);
    expect(s.tree({ at: 2 }).entries.map((e) => e.path)).toEqual(["t/b.md"]);
    expect(s.tree().entries).toEqual([]);
    expect(s.history("t/b.md").events.map((e) => e.op)).toEqual(["put", "move", "delete"]);
    expect(s.requests().requests.map((r) => r.note)).toEqual([null, "rename", "create"]);
    expect(s.requests({ limit: 1 }).next).toBe(3);
    // Moves name both paths; entries link to where the file is now, and to nothing once deleted.
    expect(s.log()).toContain("* **Move** by `agent/2`: rename t/a.md → `t/b.md`");
    expect(s.log()).toContain("* **Creation** by `agent/1`: create `t/a.md`");
    expect(s.log({ at: 2 })).toContain(
      "* **Move** by `agent/2`: rename t/a.md → [t/b.md](/t/b.md)",
    );
    expect(s.log({ at: 2 })).toContain("* **Creation** by `agent/1`: create [t/a.md](/t/b.md)");
    expect(errorOf(() => s.read("t/a.md", { at: 9 })).code).toBe("bad_seq");
  });
});

describe("queries", () => {
  test("tree, pages, search, grep and index", () => {
    const s = newStore();
    s.apply(ctx(), [
      {
        op: "write",
        path: "m/rev.md",
        content: md(
          "Metric",
          "Revenue is money in.\n",
          "title: Revenue\ntags: [finance]\nstale_after: 2020-01-01T00:00:00Z\n",
        ),
      },
      {
        op: "write",
        path: "m/cost.md",
        content: md("Metric", "Costs are money out.\n", "title: Cost\nstatus: draft\n"),
      },
      {
        op: "write",
        path: "t/orders.md",
        content: md("Table", "Orders table.\n", "description: One row per order.\n"),
      },
    ]);
    expect(s.tree({ depth: 1 }).entries.map((e) => [e.path, e.kind])).toEqual([
      ["m", "dir"],
      ["t", "dir"],
    ]);
    expect(s.pages({ prefix: "m" }).items.map((r) => r.path)).toEqual(["m/cost.md", "m/rev.md"]);
    expect(s.pages({ stale: true }).items.map((r) => r.path)).toEqual(["m/rev.md"]);
    expect(s.pages({ status: "draft", tag: "finance" }).items).toEqual([]);
    expect(
      s
        .search("money")
        .results.map((r) => r.path)
        .sort(),
    ).toEqual(["m/cost.md", "m/rev.md"]);
    expect(s.search("money", { prefix: "t" }).results).toEqual([]);
    expect(s.grep("type: Metric").matches.map((m) => [m.path, m.line])).toEqual([
      ["m/cost.md", 2],
      ["m/rev.md", 2],
    ]);
    expect(s.grep("^description: One", { regex: true }).matches.map((m) => m.path)).toEqual([
      "t/orders.md",
    ]);
    expect(s.index("")).toBe(
      "# Subdirectories\n\n* [m](m/index.md) - 2 pages\n* [t](t/index.md) - 1 page\n",
    );
    // An OKF export's index says its version and names pages as OKF does.
    expect(s.index("", undefined, { okf: true })).toBe(
      '---\nokf_version: "0.2"\n---\n\n# Subdirectories\n\n* [m](m/index.md) - 2 concepts\n* [t](t/index.md) - 1 concept\n',
    );
    expect(s.index("t")).toBe("# Pages\n\n* [orders](orders.md) - One row per order.\n");
    expect(errorOf(() => s.index("nope")).status).toBe(404);
  });
});

function importFiles(name: string): ImportFile[] {
  return loadBundle(name).map((f) =>
    isPagePath(f.path) || f.path.endsWith(".md")
      ? { path: f.path, markdown: text(f.bytes) }
      : { path: f.path, blob: { hash: sha256Hex(f.bytes), size: f.bytes.length, media: null } },
  );
}

describe("import and export round-trip the sample bundles (store level)", () => {
  for (const bundle of BUNDLES) {
    test(bundle, () => {
      const s = newStore();
      const files = importFiles(bundle);
      const res = s.import(ctx("human:importer"), files, `fixtures/${bundle}`);
      // Internal sources resolve, including acme's bundle-root-relative ones; none is broken.
      expect(s.work({ kind: "broken_link" }).items).toEqual([]);
      if (bundle === "acme_retail") {
        const citing = s
          .links("policies/revenue-recognition.md")
          .inbound.filter((l) => l.kind === "source")
          .map((l) => l.path);
        expect(citing).toEqual([
          "computations/gross-margin-period.md",
          "computations/revenue-ytd.md",
          "metrics/gross-margin.md",
          "metrics/revenue.md",
          "tables/orders.md",
        ]);
      }
      expect(res.skipped.every((p) => p.endsWith("index.md") || p.endsWith("log.md"))).toBe(true);
      // One request for the whole bundle.
      expect(new Set(s.events({ limit: 1000 }).events.map((e) => e.request_id)).size).toBe(1);
      const out = new Map(s.exportBundle().files.map((f) => [f.path, f]));
      for (const f of files) {
        if (f.path.endsWith("index.md") || f.path.endsWith("log.md")) continue;
        const got = out.get(f.path);
        expect(got).toBeDefined();
        if ("blob" in f) {
          expect(got?.blob?.hash).toBe(f.blob.hash);
          continue;
        }
        const a = parsePage(f.markdown);
        const b = parsePage(got?.text ?? "");
        expect(jsonEqual(Object.fromEntries(b.entries), Object.fromEntries(a.entries))).toBe(true);
        expect(jsonEqual(b.generated, a.generated)).toBe(true);
        expect(b.verified).toEqual(a.verified);
        expect(b.body).toBe(normalize(a.body));
      }
      // Re-importing the same bundle changes nothing.
      const head = s.headSeq();
      s.import(ctx("human:importer"), files);
      expect(s.headSeq()).toBe(head);
    });
  }
});

describe("tier 2", () => {
  test("stored lint drops a broken link once its target exists", () => {
    const s = newStore();
    s.apply(ctx(), [{ op: "write", path: "a.md", content: md("Memo", "[b](/b.md)\n") }]);
    expect(pageView(s.read("a.md")).lint.map((l) => l.code)).toEqual(["broken_link"]);
    s.apply(ctx(), [{ op: "write", path: "b.md", content: md("Memo", "b\n") }]);
    expect(pageView(s.read("a.md")).lint).toEqual([]);
    expect(s.work({ kind: "broken_link" }).items).toEqual([]);
  });

  test("internal sources follow moves, render in their written form, and flag when missing", () => {
    const s = newStore();
    const sources = [
      "sources:",
      "  - id: abs",
      "    resource: /pol/a.md",
      "  - id: root",
      "    resource: pol/b.md",
      "  - id: rel",
      "    resource: ../pol/c.md#part",
      "  - id: gone",
      "    resource: /pol/missing.md",
      "  - id: ext",
      "    resource: https://e.com/pol/a.md",
      "  - id: word",
      "    resource: the orders table",
      "",
    ].join("\n");
    s.apply(ctx(), [
      { op: "write", path: "pol/a.md", content: md("Policy", "A\n") },
      { op: "write", path: "pol/b.md", content: md("Policy", "B\n") },
      { op: "write", path: "pol/c.md", content: md("Policy", "C\n") },
      {
        op: "write",
        path: "m/x.md",
        content: md("Metric", "Uses [^abs].\n\n[^abs]: a\n", sources),
      },
    ]);
    const before = pageView(s.read("m/x.md"));
    expect(before.lint.map((l) => [l.code, l.target])).toEqual([["broken_link", "pol/missing.md"]]);
    expect(before.lint[0]?.message).toContain("Source resource /pol/missing.md");
    // Unmoved, every resource renders exactly as written.
    expect(before.markdown).toContain(sources.slice("sources:\n".length, -1));
    expect(s.work({ kind: "broken_link" }).items.map((i) => [i.kind, i.path])).toEqual([
      ["broken_link", "m/x.md"],
    ]);
    expect(pageView(s.read("pol/a.md")).inbound_links).toBe(1);
    const seqBefore = s.headSeq();

    s.apply(ctx(), [{ op: "move", path: "pol", to: "policies" }]);
    const after = pageView(s.read("m/x.md"));
    const resources = (after.frontmatter.sources as { resource: string }[]).map((x) => x.resource);
    expect(resources).toEqual([
      "/policies/a.md",
      "policies/b.md",
      "../policies/c.md#part",
      "/pol/missing.md",
      "https://e.com/pol/a.md",
      "the orders table",
    ]);
    // A move creates no content version, and an old snapshot renders the old paths.
    expect(after.hash).toBe(before.hash);
    expect(pageView(s.read("m/x.md", { at: seqBefore })).markdown).toBe(before.markdown);

    const src = s.sources("m/x.md");
    expect(src.sources.map((x) => [x.id, x.resource, x.cited, x.internal])).toEqual([
      [
        "abs",
        "/policies/a.md",
        1,
        {
          path: "policies/a.md",
          trust_tier: "unverified",
          stale: false,
          status: "stable",
          inbound_links: 1,
          // The test read pol/a.md once, before the move.
          usage_count: 1,
        },
      ],
      ["root", "policies/b.md", 0, expect.objectContaining({ path: "policies/b.md" })],
      ["rel", "../policies/c.md#part", 0, expect.objectContaining({ path: "policies/c.md" })],
      ["gone", "/pol/missing.md", 0, { path: "pol/missing.md", broken: true }],
      ["ext", "https://e.com/pol/a.md", 0, null],
      ["word", "the orders table", 0, null],
    ]);
    const links = s.links("m/x.md");
    expect(links.outbound.map((l) => [l.path, l.kind])).toEqual([
      ["policies/a.md", "source"],
      ["policies/b.md", "source"],
      ["policies/c.md", "source"],
    ]);
    expect(links.broken).toEqual([
      { raw: "/pol/missing.md", path: "pol/missing.md", kind: "source" },
    ]);
    // `raw` is the link as `read` renders it now, not as first written.
    expect(s.links("policies/a.md").inbound).toEqual([
      { path: "m/x.md", raw: "/policies/a.md", anchor: null, kind: "source" },
    ]);

    // Writing the missing target clears the flag; exporting renders current paths.
    s.apply(ctx(), [{ op: "write", path: "pol/missing.md", content: md("Policy", "M\n") }]);
    expect(pageView(s.read("m/x.md")).lint).toEqual([]);
    expect(s.work({ kind: "broken_link" }).items).toEqual([]);
    const exported = s.exportBundle().files.find((f) => f.path === "m/x.md");
    expect(exported && "text" in exported ? exported.text : "").toContain("/policies/a.md");
  });

  test("cited counts every reference; undefined footnotes are counted and linted", () => {
    const s = newStore();
    const r = s.apply(ctx(), [
      {
        op: "write",
        path: "m.md",
        content: md(
          "Metric",
          "A.[^spec] B.[^spec] C.[^spec] D.[^loose]\n\n[^spec]: Spec\n",
          "sources:\n  - { id: spec, resource: https://e.com }\n  - { id: loose, resource: https://f.com }\n",
        ),
      },
    ]);
    expect(r.results[0]?.lint.map((l) => l.code)).toEqual(["footnote_undefined"]);
    expect(s.sources("m.md").sources.map((x) => [x.id, x.cited])).toEqual([
      ["spec", 3],
      ["loose", 1],
    ]);
    s.apply(ctx(), [{ op: "write", path: "n.md", content: md("Memo", "Orphan.[^nosrc]\n") }]);
    const n = s.sources("n.md");
    expect(n.unmatched_footnotes).toEqual(["nosrc"]);
    expect(pageView(s.read("n.md")).lint.map((l) => l.code)).toEqual([
      "footnote_unmatched",
      "footnote_undefined",
    ]);
  });

  test("reading a past version reports that version's lint", () => {
    const s = newStore();
    s.apply(ctx(), [
      {
        op: "write",
        path: "a.md",
        content: md("Memo", "See [b](/b.md).\n", "sources:\n  - { id: x }\n"),
      },
    ]);
    const first = s.headSeq();
    const h = pageView(s.read("a.md")).hash;
    s.apply(ctx(), [{ op: "write", path: "a.md", content: md("Memo", "Fixed.\n"), if_match: h }]);
    expect(pageView(s.read("a.md")).lint).toEqual([]);
    expect(
      pageView(s.read("a.md", { at: first })).lint.map((l) => [l.code, l.target ?? null]),
    ).toEqual([
      ["source_missing_resource", null],
      ["broken_link", "b.md"],
    ]);
    // A link that was broken then but has a target now is still reported as of then.
    s.apply(ctx(), [{ op: "write", path: "b.md", content: md("Memo", "b\n") }]);
    expect(pageView(s.read("a.md", { at: first })).lint.map((l) => l.code)).toContain(
      "broken_link",
    );
  });

  test("sources, diff, verify and signed downloads", () => {
    const s = newStore();
    s.apply(ctx(), [
      { op: "write", path: "p.md", content: md("Policy", "Rules.\n") },
      {
        op: "write",
        path: "m.md",
        content: md(
          "Metric",
          "Claim.[^pol] Other.[^nope]\n\n[^pol]: Policy\n[^nope]: x\n",
          "sources:\n  - { id: pol, resource: /p.md }\n  - { resource: https://e.com }\n",
        ),
      },
    ]);
    const src = s.sources("m.md");
    expect(
      src.sources.map((x) => [x.cited, (x.internal as { path?: string } | null)?.path]),
    ).toEqual([
      [1, "p.md"],
      [0, undefined],
    ]);
    expect(src.unmatched_footnotes).toEqual(["nope"]);

    const h = pageView(s.read("p.md")).hash;
    s.apply(ctx(), [
      { op: "write", path: "p.md", content: md("Policy", "New rules.\n"), if_match: h },
    ]);
    const d = s.diff("p.md");
    expect([d.from, d.to]).toEqual([2, 3]);
    expect(d.diff).toContain("-Rules.\n+New rules.");

    expect(errorOf(() => s.verify(ctx("claude-code/x"), "p.md")).code).toBe("cannot_verify");
    s.verify(ctx("human:me"), "p.md");
    expect(pageView(s.read("p.md")).trust_tier).toBe("human-reviewed");

    const token = s.signDownload({ k: "export", at: 2 });
    expect(s.openDownload(token)).toMatchObject({ k: "export", at: 2 });
    expect(errorOf(() => s.openDownload(`${token}x`)).code).toBe("bad_download");
  });
});
