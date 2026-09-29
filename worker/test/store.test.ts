import { describe, expect, test } from "bun:test";
import { jsonEqual, parseConcept } from "../src/okf/concept";
import { sha256Hex } from "../src/okf/hash";
import { isConceptPath } from "../src/okf/paths";
import { OkfError } from "../src/store/errors";
import {
  type FileView,
  type ImportFile,
  LibraryStore,
  type RequestContext,
} from "../src/store/store";
import { BUNDLES, loadBundle, text } from "./fixtures";
import { bunSqlHandle } from "./sqlite";

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

function errorOf(fn: () => unknown): OkfError {
  try {
    fn();
  } catch (e) {
    if (e instanceof OkfError) return e;
    throw e;
  }
  throw new Error("expected an OkfError");
}

function conceptView(v: FileView) {
  if (v.kind !== "concept") throw new Error(`expected a concept, got ${v.kind}`);
  return v;
}

const md = (type: string, body: string, extra = "") => `---\ntype: ${type}\n${extra}---\n${body}`;

describe("write path", () => {
  test("create, conditional replace, stamping and events", () => {
    const s = newStore();
    const r1 = s.apply(ctx("agent/1", "first"), [
      {
        op: "write",
        path: "a.md",
        content: md("Note", "Hello\n", "generated: { by: x/1, at: 2020-01-01T00:00:00Z }\n"),
      },
    ]);
    const res = r1.results[0];
    expect(res?.seq).toBe(1);
    expect(res?.lint.map((l) => l.code)).toEqual(["generated_ignored"]);
    const view = s.read("a");
    if (view.kind !== "concept") throw new Error("not a concept");
    expect(view.frontmatter.generated).toEqual({ by: "agent/1", at: "2026-09-29T12:00:01Z" });

    // Replace without If-Match fails with the current hash.
    const e = errorOf(() =>
      s.apply(ctx(), [{ op: "write", path: "a.md", content: md("Note", "x") }]),
    );
    expect(e.status).toBe(412);
    expect(e.extra.current_hash).toBe(view.hash);
    // Stale If-Match fails; the right one succeeds.
    expect(
      errorOf(() => s.apply(ctx(), [{ op: "write", path: "a.md", content: "x", if_match: "nope" }]))
        .status,
    ).toBe(412);
    const r2 = s.apply(ctx(), [
      { op: "write", path: "a.md", content: md("Note", "Bye\n"), if_match: view.hash },
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
    const s = new LibraryStore(bunSqlHandle(), { conceptCap: 200 });
    expect(
      errorOf(() => s.apply(ctx(), [{ op: "write", path: "x/index.md", content: "x" }])).status,
    ).toBe(405);
    const big = errorOf(() =>
      s.apply(ctx(), [{ op: "write", path: "big.md", content: md("Note", "y".repeat(500)) }]),
    );
    expect([big.status, big.code]).toEqual([413, "concept_too_large"]);
    expect(s.headSeq()).toBe(0);
  });

  test("a failing op rolls back the whole request", () => {
    const s = newStore();
    const e = errorOf(() =>
      s.apply(ctx(), [
        { op: "write", path: "a.md", content: md("Note", "a") },
        { op: "delete", path: "missing.md", if_match: "x" },
      ]),
    );
    expect(e.status).toBe(404);
    expect(s.headSeq()).toBe(0);
    expect(s.tree().entries).toEqual([]);
  });

  test("edit applies find-and-replace on the rendered document", () => {
    const s = newStore();
    s.apply(ctx(), [{ op: "write", path: "a.md", content: md("Note", "one two\n") }]);
    s.apply(ctx(), [
      {
        op: "edit",
        path: "a.md",
        edits: [
          { old: "type: Note", new: "type: Memo" },
          { old: "two", new: "2" },
        ],
      },
    ]);
    const v = s.read("a.md");
    if (v.kind !== "concept") throw new Error();
    expect(v.frontmatter.type).toBe("Memo");
    expect(v.body).toBe("one 2\n");
    const miss = errorOf(() =>
      s.apply(ctx(), [{ op: "edit", path: "a.md", edits: [{ old: "zzz", new: "" }] }]),
    );
    expect([miss.status, miss.code]).toEqual([409, "edit_mismatch"]);
    expect(typeof miss.extra.current).toBe("string");
  });

  test("server-owned keys echoed back produce no lint; changed ones do", () => {
    const s = newStore();
    s.apply(ctx(), [{ op: "write", path: "a.md", content: md("Note", "x\n") }]);
    const v = s.read("a.md");
    if (v.kind !== "concept") throw new Error();
    const echoed = s.apply(ctx(), [
      { op: "write", path: "a.md", content: v.markdown, if_match: v.hash },
    ]);
    expect(echoed.results[0]?.lint).toEqual([]);
    const v2 = conceptView(s.read("a.md"));
    const changed = v2.markdown.replace(
      /generated: \{[^}]*\}/,
      "generated: { by: me/1, at: 2020-01-01T00:00:00Z }",
    );
    const r = s.apply(ctx(), [{ op: "write", path: "a.md", content: changed, if_match: v2.hash }]);
    expect(r.results[0]?.lint.map((l) => l.code)).toEqual(["generated_ignored"]);
  });
});

describe("links", () => {
  test("links survive moves of either end and render in their written form", () => {
    const s = newStore();
    s.apply(ctx(), [
      {
        op: "write",
        path: "a/one.md",
        content: md("Note", "See [two](./two.md), [abs](/a/two.md#x) and [gone](missing.md).\n"),
      },
      { op: "write", path: "a/two.md", content: md("Note", "Back to [one](one.md).\n") },
    ]);
    const lint = s.read("a/one.md");
    if (lint.kind !== "concept") throw new Error();
    expect(lint.lint.map((l) => [l.code, l.target])).toEqual([["broken_link", "a/missing.md"]]);
    expect(lint.body).toContain("[two](./two.md)");

    s.apply(ctx(), [{ op: "move", path: "a/two.md", to: "b/deep/two.md" }]);
    const one = s.read("a/one.md");
    if (one.kind !== "concept") throw new Error();
    expect(one.body).toBe(
      "See [two](../b/deep/two.md), [abs](/b/deep/two.md#x) and [gone](missing.md).\n",
    );
    const two = s.read("b/deep/two.md");
    if (two.kind !== "concept") throw new Error();
    expect(two.body).toBe("Back to [one](../../a/one.md).\n");

    // Reading as of before the move renders the links as they were then.
    const old = s.read("a/one.md", { at: 1 });
    if (old.kind !== "concept") throw new Error();
    expect(old.body).toContain("[two](./two.md)");

    // Creating the missing target heals the broken link.
    s.apply(ctx(), [{ op: "write", path: "a/missing.md", content: md("Note", "now here\n") }]);
    expect(s.links("a/one.md").broken).toEqual([]);
    expect(s.links("a/missing.md").inbound.map((l) => l.path)).toEqual(["a/one.md"]);
  });

  test("directory move is one request with one event per file", () => {
    const s = newStore();
    s.apply(ctx(), [
      { op: "write", path: "d/x.md", content: md("Note", "[y](y.md)") },
      { op: "write", path: "d/y.md", content: md("Note", "[out](/top.md)") },
      { op: "write", path: "top.md", content: md("Note", "[x](d/x.md)") },
    ]);
    const r = s.apply(ctx(), [{ op: "move", path: "d", to: "e/f" }]);
    expect(s.request(r.request_id).events.map((e) => [e.op, e.meta?.from_path, e.path])).toEqual([
      ["move", "d/x.md", "e/f/x.md"],
      ["move", "d/y.md", "e/f/y.md"],
    ]);
    const top = s.read("top.md");
    if (top.kind !== "concept") throw new Error();
    expect(top.body).toBe("[x](e/f/x.md)");
    // Collisions fail the whole move.
    s.apply(ctx(), [{ op: "write", path: "g/x.md", content: md("Note", "") }]);
    expect(errorOf(() => s.apply(ctx(), [{ op: "move", path: "e/f", to: "g" }])).status).toBe(409);
  });
});

describe("ledger", () => {
  test("revert a path and a request, forward-only", () => {
    const s = newStore();
    s.apply(ctx(), [{ op: "write", path: "a.md", content: md("Note", "v1\n") }]);
    const h1 = s.read("a.md").kind === "concept" ? (s.read("a.md") as { hash: string }).hash : "";
    const r2 = s.apply(ctx(), [
      { op: "write", path: "a.md", content: md("Note", "v2\n"), if_match: h1 },
    ]);
    const rv = s.revert(ctx("human:me"), { path: "a.md", to_seq: 1 });
    expect(rv.results[0]?.hash).toBe(h1);
    const v = s.read("a.md");
    if (v.kind !== "concept") throw new Error();
    expect(v.body).toBe("v1\n");
    expect(v.frontmatter.generated).toEqual({ by: "claude-code/test", at: "2026-09-29T12:00:01Z" });

    // Revert the request that wrote v2: back to v1 is already true, so nothing to do.
    expect(errorOf(() => s.revert(ctx(), { request_id: r2.request_id })).code).toBe(
      "nothing_to_revert",
    );

    // A request that creates, moves and deletes is undone by reverting it.
    s.apply(ctx(), [{ op: "write", path: "b.md", content: md("Note", "b\n") }]);
    const hb = (s.read("b.md") as { hash: string }).hash;
    const big = s.apply(ctx(), [
      { op: "write", path: "c.md", content: md("Note", "c\n") },
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
    s.apply(ctx("agent/1", "create"), [{ op: "write", path: "t/a.md", content: md("Note", "a") }]);
    const h = (s.read("t/a.md") as { hash: string }).hash;
    s.apply(ctx("agent/2", "rename"), [{ op: "move", path: "t/a.md", to: "t/b.md" }]);
    s.apply(ctx("agent/2"), [{ op: "delete", path: "t/b.md", if_match: h }]);
    expect(s.tree({ at: 1 }).entries.map((e) => e.path)).toEqual(["t/a.md"]);
    expect(s.tree({ at: 2 }).entries.map((e) => e.path)).toEqual(["t/b.md"]);
    expect(s.tree().entries).toEqual([]);
    expect(s.history("t/b.md").events.map((e) => e.op)).toEqual(["put", "move", "delete"]);
    expect(s.requests().requests.map((r) => r.note)).toEqual([null, "rename", "create"]);
    expect(s.requests({ limit: 1 }).next).toBe(3);
    expect(s.log()).toContain("* **Move** by `agent/2`: rename [t/b.md](/t/b.md)");
    expect(errorOf(() => s.read("t/a.md", { at: 9 })).code).toBe("bad_seq");
  });
});

describe("queries", () => {
  test("tree, concepts, search, grep and index", () => {
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
    expect(s.concepts({ type: "Metric" }).items.map((r) => r.path)).toEqual([
      "m/cost.md",
      "m/rev.md",
    ]);
    expect(s.concepts({ stale: true }).items.map((r) => r.path)).toEqual(["m/rev.md"]);
    expect(s.concepts({ status: "draft", tag: "finance" }).items).toEqual([]);
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
    expect(s.grep("^desc", { regex: true }).matches.map((m) => m.path)).toEqual(["t/orders.md"]);
    expect(s.index("")).toBe(
      '---\nokf_version: "0.2"\n---\n\n# Subdirectories\n\n* [m](m/index.md) - 2 concepts\n* [t](t/index.md) - 1 concept\n',
    );
    expect(s.index("t")).toBe("# Concepts\n\n* [orders](orders.md) - One row per order.\n");
    expect(errorOf(() => s.index("nope")).status).toBe(404);
  });
});

function importFiles(name: string): ImportFile[] {
  return loadBundle(name).map((f) =>
    isConceptPath(f.path) || f.path.endsWith(".md")
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
        const a = parseConcept(f.markdown);
        const b = parseConcept(got?.text ?? "");
        expect(jsonEqual(Object.fromEntries(b.entries), Object.fromEntries(a.entries))).toBe(true);
        expect(jsonEqual(b.generated, a.generated)).toBe(true);
        expect(b.verified).toEqual(a.verified);
        expect(b.body).toBe(a.body);
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
    s.apply(ctx(), [{ op: "write", path: "a.md", content: md("Note", "[b](b.md)\n") }]);
    expect(conceptView(s.read("a.md")).lint.map((l) => l.code)).toEqual(["broken_link"]);
    s.apply(ctx(), [{ op: "write", path: "b.md", content: md("Note", "b\n") }]);
    expect(conceptView(s.read("a.md")).lint).toEqual([]);
    expect(s.work().items).toEqual([]);
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

    const h = conceptView(s.read("p.md")).hash;
    s.apply(ctx(), [
      { op: "write", path: "p.md", content: md("Policy", "New rules.\n"), if_match: h },
    ]);
    const d = s.diff("p.md");
    expect([d.from, d.to]).toEqual([2, 3]);
    expect(d.diff).toContain("-Rules.\n+New rules.");

    expect(errorOf(() => s.verify(ctx("claude-code/x"), "p.md")).code).toBe("cannot_verify");
    s.verify(ctx("human:me"), "p.md");
    expect(conceptView(s.read("p.md")).trust_tier).toBe("human-reviewed");

    const token = s.signDownload({ k: "export", at: 2 });
    expect(s.openDownload(token)).toMatchObject({ k: "export", at: 2 });
    expect(errorOf(() => s.openDownload(`${token}x`)).code).toBe("bad_download");
  });
});
