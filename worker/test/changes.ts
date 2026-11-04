import { Database } from "bun:sqlite";
import { LibraryStore, type RequestContext } from "../src/store/store";
import { bunSqlHandle } from "./sqlite";

/**
 * A small library changed in every way a write can change one (TEMPRA-86, TEMPRA-87), for tests
 * that compare what a store keeps with what a fresh store works out.
 */
export const DAY = 86_400_000;
export const md = (title: string, body: string, extra = "") =>
  `---\ntype: ${title.startsWith("M") ? "Metric" : "Table"}\ntitle: ${title}\ndescription: About ${title}.\n${extra}---\n${body}`;

export function library() {
  const db = new Database(":memory:");
  const clock = { t: Date.parse("2026-10-01T00:00:00Z") };
  const opts = { now: () => new Date(clock.t) };
  const store = new LibraryStore(bunSqlHandle(db), opts);
  /** A second instance on the same database: nothing cached, everything worked out afresh. */
  const fresh = () => new LibraryStore(bunSqlHandle(db), opts);
  let n = 0;
  const ctx = (by?: RequestContext["by"], actor = "claude-code/test"): RequestContext => ({
    actor,
    request_id: `req-${++n}`,
    note: `note ${n}`,
    by,
  });
  const hash = (path: string) => {
    const v = fresh().read(path);
    return v.kind === "page" || v.kind === "attachment" ? v.hash : undefined;
  };
  return { db, clock, store, fresh, ctx, hash };
}

/** A library with every kind of open work, then changed in every way a write can change it. */
export function* changes(lib: ReturnType<typeof library>) {
  const { store, ctx, hash, clock } = lib;
  const ann = { person: "u-ann", agent: "claude.ai" };
  const bob = { person: "u-bob" };
  store.apply(ctx(ann), [
    {
      op: "write",
      path: "a/one.md",
      content: md("M one", "# One\n\n## Details\n\nSee [two](/a/two.md#details).\n"),
    },
    {
      op: "write",
      path: "a/two.md",
      content: md("T two", "# Two\n\n## Details\n\nSee [one](/a/one.md#nothing).\n"),
    },
    {
      op: "write",
      path: "b/three.md",
      content: md(
        "T three",
        "Links to [gone](/b/missing.md) and [one](/a/one.md#details).\n",
        "stale_after: 2026-10-10T00:00:00Z\n",
      ),
    },
    {
      op: "write",
      path: "b/four.md",
      content: md("M four", "Old soon.\n", "stale_after: 2026-09-01T00:00:00Z\n"),
    },
    { op: "write", path: "c/five.md", content: "---\ntype: Note\n---\nNo title.\n" },
  ]);
  yield "first batch";
  store.comment(ctx(bob, "human:bob"), { kind: "open", path: "a/one.md", body: "Is this right?" });
  store.comment(ctx(bob, "human:bob"), { kind: "open", path: "b/four.md", body: "Out of date." });
  yield "comments";
  store.apply(ctx(ann), [
    {
      op: "write",
      path: "a/two.md",
      content: md("T two", "# Two\n\n## Renamed\n\nSee [one](/a/one.md#one).\n"),
      if_match: hash("a/two.md"),
    },
  ]);
  yield "a heading goes";
  store.apply(ctx(bob), [{ op: "move", path: "a/one.md", to: "d/one.md" }]);
  yield "a move";
  store.apply(ctx(ann), [
    { op: "write", path: "b/missing.md", content: md("T missing", "# Here now\n") },
  ]);
  yield "a broken link heals";
  store.verify(ctx(bob, "human:bob"), "b/three.md");
  yield "a verify";
  const thread = store.comments({ status: "open" }).threads[0]?.id as string;
  store.comment(ctx(ann), { kind: "resolve", thread, body: "Done." });
  yield "a thread resolved";
  store.apply(ctx(bob), [{ op: "delete", path: "b/four.md", if_match: hash("b/four.md") }]);
  yield "a delete with an open thread refused, or done";
  store.apply(ctx(ann), [
    {
      op: "write",
      path: "a/two.md",
      content: md("T two", "# Two\n\n## Details\n\nBack.\n"),
      if_match: hash("a/two.md"),
    },
    {
      op: "write",
      path: "e/six.md",
      content: md("M six", "See [two](/a/two.md#details) and [one](/a/one.md#details).\n"),
    },
  ]);
  yield "a heading comes back, a link through a redirect";
  const seq = store.headSeq();
  store.revert(ctx(bob), { path: "a/two.md", to_seq: seq - 3 });
  yield "a revert";
  store.import(ctx(ann), [
    { path: "f/seven.md", markdown: md("M seven", "See [six](/e/six.md#nope).\n") },
    { path: "f/index.md", markdown: "ignored" },
  ]);
  yield "an import";
  try {
    store.apply(ctx(ann), [
      { op: "write", path: "g/eight.md", content: md("M eight", "x\n") },
      { op: "write", path: "a/two.md", content: md("T two", "y\n"), if_match: "wrong" },
    ]);
  } catch {
    // Rolled back: counts must not move.
  }
  yield "a refused write";
  clock.t += 20 * DAY;
  yield "time passes";
}
