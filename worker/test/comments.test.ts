import { describe, expect, test } from "bun:test";
import { docText } from "@tempra/editor/doc";
import { StoreError } from "../src/store/errors";
import { LibraryStore, type RequestContext } from "../src/store/store";
import { WRITE_TOOLS } from "../src/usage";
import { bunSqlHandle } from "./sqlite";

let n = 0;
const ctx = (actor = "claude-code/test", note?: string): RequestContext => ({
  actor,
  request_id: `req-${++n}`,
  note,
});
const human = () => ctx("human:ana");

function newStore() {
  let t = Date.parse("2026-10-05T12:00:00Z");
  return new LibraryStore(bunSqlHandle(), {
    now: () => {
      t += 1000;
      return new Date(t);
    },
  });
}

/** A file's text, as anchors quote it. */
const textOf = (v: ReturnType<LibraryStore["read"]>) =>
  v.kind === "page" ? docText(v.doc).text : "";

const doc = (body: string) =>
  `---\ntype: Metric\ntitle: Margin\ndescription: Gross margin.\n---\n${body}`;

function seeded() {
  const s = newStore();
  s.apply(ctx(), [
    {
      op: "write",
      path: "metrics/margin.md",
      content: doc("# Margin\n\nMargin is revenue minus cost. Margin is reported monthly.\n"),
    },
  ]);
  return s;
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

describe("comment threads", () => {
  test("open on a quote, reply, resolve and reopen, each one ledger event", () => {
    const s = seeded();
    const version = s.read("metrics/margin.md");
    const opened = s.comment(human(), {
      kind: "open",
      path: "metrics/margin",
      body: "This contradicts the margin standard.",
      anchor: { quote: "revenue minus cost" },
    });
    const t = opened.thread;
    expect(t.status).toBe("open");
    expect(t.actor).toBe("human:ana");
    expect(t.anchor?.quote).toBe("revenue minus cost");
    expect(t.outdated).toBe(false);
    expect(textOf(version).slice(t.located?.from, t.located?.to)).toBe("revenue minus cost");

    s.comment(ctx("agent:a"), { kind: "reply", thread: t.id, body: "Fixed in the body." });
    s.comment(ctx("agent:a"), { kind: "resolve", thread: t.id });
    const resolved = s.thread(t.id);
    expect(resolved.status).toBe("resolved");
    expect(resolved.resolved_by).toBe("agent:a");
    expect(resolved.comments.map((c) => c.body)).toEqual([
      "This contradicts the margin standard.",
      "Fixed in the body.",
    ]);
    expect(resolved.replies).toBe(1);
    s.comment(human(), { kind: "reopen", thread: t.id, body: "Not yet." });
    expect(s.thread(t.id).status).toBe("open");

    const events = s.history("metrics/margin.md").events.filter((e) => e.op === "comment");
    expect(events.map((e) => (e.meta?.comment as { kind?: string } | undefined)?.kind)).toEqual([
      "open",
      "reply",
      "resolve",
      "reopen",
    ]);
    // Comments never change the page: same hash, same version.
    const after = s.read("metrics/margin.md");
    expect(after.kind === "page" && after.hash).toBe(version.kind === "page" && version.hash);
    expect(after.seq).toBe(version.seq);
    for (const e of events) expect(e.hash).toBe(e.prev_hash);
  });

  test("an ambiguous or missing quote is refused; `from` picks among repeats", () => {
    const s = seeded();
    expect(
      errorOf(() =>
        s.comment(human(), {
          kind: "open",
          path: "metrics/margin.md",
          body: "x",
          anchor: { quote: "Margin is" },
        }),
      ).code,
    ).toBe("quote_ambiguous");
    expect(
      errorOf(() =>
        s.comment(human(), {
          kind: "open",
          path: "metrics/margin.md",
          body: "x",
          anchor: { quote: "not there" },
        }),
      ).code,
    ).toBe("quote_not_found");
    const second = textOf(s.read("metrics/margin.md")).lastIndexOf("Margin is");
    const t = s.comment(human(), {
      kind: "open",
      path: "metrics/margin.md",
      body: "Which month?",
      anchor: { quote: "Margin is", from: second },
    }).thread;
    expect(t.located?.from).toBe(second);
  });

  test("anchors follow edits, go outdated when the quote is gone, and come back", () => {
    const s = seeded();
    const t = s.comment(human(), {
      kind: "open",
      path: "metrics/margin.md",
      body: "Say which cost.",
      anchor: { quote: "revenue minus cost" },
    }).thread;
    s.apply(ctx(), [
      {
        op: "edit",
        path: "metrics/margin.md",
        edits: [{ old: "# Margin\n", new: "# Margin\n\nAn intro paragraph first.\n" }],
      },
    ]);
    const moved = s.thread(t.id);
    const body = textOf(s.read("metrics/margin.md"));
    expect(body.slice(moved.located?.from, moved.located?.to)).toBe("revenue minus cost");
    expect(moved.located?.from).toBeGreaterThan(t.located?.from ?? 0);

    s.apply(ctx(), [
      {
        op: "edit",
        path: "metrics/margin.md",
        edits: [{ old: "revenue minus cost", new: "revenue minus cost of goods sold" }],
      },
    ]);
    // The quote is still there (now followed by more words).
    expect(s.thread(t.id).outdated).toBe(false);
    s.apply(ctx(), [
      {
        op: "edit",
        path: "metrics/margin.md",
        edits: [{ old: "revenue minus cost of goods sold", new: "net sales less COGS" }],
      },
    ]);
    expect(s.thread(t.id).outdated).toBe(true);
    expect(s.thread(t.id).located).toBeNull();
  });

  test("an anchor is on its block, and the block keeps its ID through an agent's edit", () => {
    const s = seeded();
    const before = s.read("metrics/margin.md");
    const para = before.kind === "page" ? before.doc.children[1] : undefined;
    const block = (para as { id?: string } | undefined)?.id;
    // An agent quotes markdown as `read` shows it; it is matched by the text it reads as.
    const t = s.comment(ctx("agent:a"), {
      kind: "open",
      path: "metrics/margin.md",
      body: "Which cost?",
      anchor: { quote: "Margin is revenue minus **cost**" },
    }).thread;
    expect(t.anchor?.block).toBe(block ?? null);
    expect(t.anchor?.offset).toBe(0);
    s.apply(ctx("agent:b"), [
      {
        op: "write",
        path: "metrics/margin.md",
        content: doc(
          "# Margin\n\nA new first paragraph.\n\nMargin is revenue minus cost. Margin is reported weekly.\n",
        ),
        if_match: before.kind === "page" ? before.hash : "",
      },
    ]);
    const after = s.read("metrics/margin.md");
    const kept = after.kind === "page" ? after.doc.children[2] : undefined;
    expect((kept as { id?: string } | undefined)?.id).toBe(block);
    const moved = s.thread(t.id);
    expect(textOf(after).slice(moved.located?.from, moved.located?.to)).toBe(
      "Margin is revenue minus cost",
    );
  });

  test("threads follow a move; a page with open threads is not deleted", () => {
    const s = seeded();
    const t = s.comment(human(), { kind: "open", path: "metrics/margin.md", body: "Hm." }).thread;
    s.apply(ctx(), [{ op: "move", path: "metrics/margin.md", to: "finance/margin.md" }]);
    expect(s.thread(t.id).path).toBe("finance/margin.md");
    const cur = s.read("finance/margin.md");
    const hash = cur.kind === "page" ? cur.hash : "";
    const head = s.headSeq();
    // Refused while the thread is open, alone or in a batch, and nothing changes.
    const refused = errorOf(() =>
      s.apply(ctx(), [{ op: "delete", path: "finance/margin.md", if_match: hash }]),
    );
    expect([refused.status, refused.code]).toEqual([409, "open_comments"]);
    expect(refused.message).toContain(t.id);
    expect(refused.extra.threads).toEqual([t.id]);
    const inBatch = errorOf(() =>
      s.apply(ctx(), [
        { op: "write", path: "other.md", content: doc("Other.\n") },
        { op: "delete", path: "finance/margin.md", if_match: hash },
      ]),
    );
    expect(inBatch.code).toBe("open_comments");
    expect(inBatch.message).toContain("Op 2 of 2 (delete finance/margin.md)");
    expect(s.headSeq()).toBe(head);
    // Resolved, it can go; a revert brings the page and its (resolved) thread back.
    s.comment(human(), { kind: "resolve", thread: t.id, body: "" });
    const del = s.apply(ctx(), [{ op: "delete", path: "finance/margin.md", if_match: hash }]);
    expect(s.comments({ status: "all" }).threads).toHaveLength(0);
    expect(errorOf(() => s.thread(t.id)).status).toBe(404);
    s.revert(ctx(), { request_id: del.request_id });
    expect(s.comments({ status: "all" }).threads.map((x) => x.id)).toEqual([t.id]);
  });

  test("a revert that would delete a page with open threads is refused", () => {
    const s = seeded();
    const made = s.apply(ctx(), [{ op: "write", path: "new.md", content: doc("New.\n") }]);
    const t = s.comment(human(), { kind: "open", path: "new.md", body: "Keep this?" }).thread;
    const e = errorOf(() => s.revert(ctx(), { request_id: made.request_id }));
    expect([e.status, e.code]).toEqual([409, "open_comments"]);
    expect(e.message).toContain(t.id);
    expect(s.read("new.md").kind).toBe("page");
  });

  test("comment events do not disturb snapshots, diffs or reverts", () => {
    const s = seeded();
    const before = s.headSeq();
    const t = s.comment(human(), {
      kind: "open",
      path: "metrics/margin.md",
      body: "Hm.",
    });
    // A past snapshot at the comment's seq still has the page at its content version.
    const atComment = s.read("metrics/margin.md", { at: t.seq });
    expect(atComment.seq).toBe(before);
    expect(s.outline({ at: t.seq }).files[0]?.seq).toBe(before);
    // Reverting the comment's request changes nothing.
    expect(errorOf(() => s.revert(ctx(), { request_id: t.request_id })).code).toBe(
      "nothing_to_revert",
    );
  });

  test("open threads show in work, outline counts and listings; resolved ones do not", () => {
    const s = seeded();
    const a = s.comment(human(), {
      kind: "open",
      path: "metrics/margin.md",
      body: "Please cite the standard.",
      anchor: { quote: "reported monthly" },
    }).thread;
    s.comment(human(), { kind: "open", path: "metrics/margin.md", body: "Second." });
    const work = s.work({ kind: "comment" });
    expect(work.items).toHaveLength(2);
    expect(work.items.map((i) => i.thread).sort()).toEqual(
      s
        .comments()
        .threads.map((x) => x.id)
        .sort(),
    );
    expect(work.items.find((i) => i.thread === a.id)?.detail).toContain("reported monthly");
    expect(s.work({ path: "metrics/margin.md" }).items.some((i) => i.kind === "comment")).toBe(
      true,
    );
    expect(s.outline().files[0]?.comments).toBe(2);
    const read = s.read("metrics/margin");
    expect(read.kind === "page" && read.open_comments).toBe(2);

    s.comment(ctx("agent:a"), { kind: "resolve", thread: a.id, body: "Cited." });
    expect(s.work({ kind: "comment" }).items).toHaveLength(1);
    expect(s.outline().files[0]?.comments).toBe(1);
    expect(s.comments({ status: "resolved" }).threads.map((x) => x.id)).toEqual([a.id]);
    expect(s.comments({ status: "all", path: "metrics/margin.md" }).threads).toHaveLength(2);
  });

  test("listings page by last activity", () => {
    const s = seeded();
    const ids: string[] = [];
    const pick = (...i: number[]) => i.map((k) => ids[k] as string);
    for (let i = 0; i < 5; i++) {
      ids.push(
        s.comment(human(), { kind: "open", path: "metrics/margin.md", body: `#${i}` }).thread.id,
      );
    }
    s.comment(human(), { kind: "reply", thread: ids[0] as string, body: "bump" });
    const first = s.comments({ limit: 2 });
    expect(first.threads.map((t) => t.id)).toEqual(pick(0, 4));
    const second = s.comments({ limit: 2, before: first.next ?? 0 });
    expect(second.threads.map((t) => t.id)).toEqual(pick(3, 2));
    const third = s.comments({ limit: 2, before: second.next ?? 0 });
    expect(third.threads.map((t) => t.id)).toEqual(pick(1));
    expect(third.next).toBeNull();
  });

  test("bodies and states are checked", () => {
    const s = seeded();
    expect(
      errorOf(() => s.comment(human(), { kind: "open", path: "metrics/margin.md", body: "  " }))
        .code,
    ).toBe("empty_comment");
    expect(
      errorOf(() =>
        s.comment(human(), { kind: "open", path: "metrics/margin.md", body: "x".repeat(10_001) }),
      ).code,
    ).toBe("comment_too_long");
    expect(
      errorOf(() => s.comment(human(), { kind: "open", path: "metrics/nope.md", body: "x" }))
        .status,
    ).toBe(404);
    const t = s.comment(human(), { kind: "open", path: "metrics/margin.md", body: "x" }).thread;
    expect(errorOf(() => s.comment(human(), { kind: "reopen", thread: t.id })).code).toBe(
      "already_open",
    );
    s.comment(human(), { kind: "resolve", thread: t.id });
    expect(errorOf(() => s.comment(human(), { kind: "resolve", thread: t.id })).code).toBe(
      "already_resolved",
    );
  });

  test("the ledger dump carries every comment in full", () => {
    const s = seeded();
    s.comment(human(), {
      kind: "open",
      path: "metrics/margin.md",
      body: "Kept in the backup.",
      anchor: { quote: "reported monthly" },
    });
    const lines = s
      .dump()
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    const ev = lines.find((l) => l.t === "event" && l.op === "comment");
    expect(ev.meta.comment.body).toBe("Kept in the backup.");
    expect(ev.meta.comment.anchor.quote).toBe("reported monthly");
  });

  test("a client's `from` is only a hint: out of range or fractional, it is ignored", () => {
    const s = seeded();
    for (const from of [-5, 1.5, 10_000]) {
      const t = s.comment(human(), {
        kind: "open",
        path: "metrics/margin.md",
        body: "x",
        anchor: { quote: "revenue minus cost", from },
      }).thread;
      expect(t.anchor?.quote).toBe("revenue minus cost");
      expect(t.anchor?.from).toBeGreaterThanOrEqual(0);
      expect(t.outdated).toBe(false);
    }
  });

  test("log.md tells content changes only; comments count as writes for limits", () => {
    const s = seeded();
    const t = s.comment(human(), { kind: "open", path: "metrics/margin.md", body: "x" }).thread;
    s.comment(human(), { kind: "resolve", thread: t.id });
    const log = s.log();
    expect(log).not.toContain("human:ana");
    expect(WRITE_TOOLS.has("comment")).toBe(true);
  });
});
