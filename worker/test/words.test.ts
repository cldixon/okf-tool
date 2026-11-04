import { describe, expect, test } from "bun:test";
import { wordChange } from "../src/format/words";
import { LibraryStore, type RequestContext } from "../src/store/store";
import { API, setup } from "./harness";
import { bunSqlHandle } from "./sqlite";

let n = 0;
const ctx = (): RequestContext => ({ actor: "claude-code/test", request_id: `req-${++n}` });

const doc = (body: string) =>
  `---\ntype: Metric\ntitle: Margin\ndescription: Gross margin.\n---\n# Margin\n\n${body}\n`;

describe("word counts for edits", () => {
  test("the bag-of-words difference: moved words are neither, changed words one of each", () => {
    // Split on whitespace only: a word that gains a full stop is a changed word.
    expect(wordChange("revenue.", "revenue minus cost.")).toEqual({
      added: 3,
      removed: 1,
      before: 1,
    });
    expect(wordChange("a b c", "a b c")).toEqual({ added: 0, removed: 0, before: 3 });
    expect(wordChange("a b c", "c b a")).toEqual({ added: 0, removed: 0, before: 3 });
    expect(wordChange("a b c", "a x c")).toEqual({ added: 1, removed: 1, before: 3 });
    expect(wordChange("the the cat", "the cat sat on the mat")).toEqual({
      added: 3,
      removed: 0,
      before: 3,
    });
    expect(wordChange("one two\n\nthree", "")).toEqual({ added: 0, removed: 3, before: 3 });
    expect(wordChange("", "  new\twords\n")).toEqual({ added: 2, removed: 0, before: 0 });
    // An atom (an image, a footnote marker) separates words and is not one.
    expect(wordChange("cost\uFFFCnote", "cost note")).toEqual({ added: 0, removed: 0, before: 2 });
  });

  test("recorded on a new version of a page, never on a create, move or delete", () => {
    const s = new LibraryStore(bunSqlHandle());
    const created = s.apply(ctx(), [
      { op: "write", path: "m.md", content: doc("Margin is revenue minus cost.") },
    ]);
    const hash = created.results[0]?.hash ?? null;
    s.apply(ctx(), [
      {
        op: "write",
        path: "m.md",
        content: doc("Margin is revenue minus all costs, monthly."),
        if_match: hash,
      },
    ]);
    const edit = s.apply(ctx(), [
      { op: "edit", path: "m.md", edits: [{ old: "monthly", new: "quarterly" }] },
    ]);
    // Reverting the edit changes its word back.
    s.revert(ctx(), { request_id: edit.request_id });
    s.apply(ctx(), [{ op: "move", path: "m.md", to: "n.md" }]);
    expect(s.history("n.md").events.map((e) => [e.op, e.meta?.words ?? null])).toEqual([
      ["put", null],
      ["put", { added: 3, removed: 1, before: 6 }],
      ["put", { added: 1, removed: 1, before: 8 }],
      ["revert", { added: 1, removed: 1, before: 8 }],
      ["move", null],
    ]);
    const current = s.pages().items[0]?.hash ?? null;
    s.apply(ctx(), [{ op: "delete", path: "n.md", if_match: current }]);
    expect(s.history("n.md").events.at(-1)?.meta?.words).toBeUndefined();
  });

  test("an import counts only over an existing page", () => {
    const s = new LibraryStore(bunSqlHandle());
    s.import(ctx(), [{ path: "m.md", markdown: doc("Margin is revenue.") }]);
    s.import(ctx(), [
      { path: "m.md", markdown: doc("Margin is revenue minus cost.") },
      { path: "o.md", markdown: doc("Other.") },
    ]);
    expect(s.history("m.md").events.map((e) => e.meta?.words ?? null)).toEqual([
      null,
      { added: 3, removed: 1, before: 4 },
    ]);
    expect(s.history("o.md").events[0]?.meta?.words).toBeUndefined();
  });

  test("in the ledger's requests and a page's history over REST", async () => {
    const s = setup();
    const put = (body: string, ifMatch?: string) =>
      s.req("/files/m.md", {
        method: "PUT",
        headers: { "Content-Type": "text/markdown", ...(ifMatch ? { "If-Match": ifMatch } : {}) },
        body: doc(body),
      });
    const first = (await (await put("Margin is revenue.")).json()) as { hash: string };
    expect((await put("Margin is revenue minus cost.", first.hash)).status).toBe(200);
    const { requests } = (await (await s.req("/requests")).json()) as {
      requests: { request_id: string; events: { meta: { words?: unknown } | null }[] }[];
    };
    expect(requests.map((r) => r.events[0]?.meta?.words ?? null)).toEqual([
      { added: 3, removed: 1, before: 4 },
      null,
    ]);
    const one = (await (await s.req(`/requests/${requests[0]?.request_id}`)).json()) as {
      events: { meta: { words?: unknown } }[];
    };
    expect(one.events[0]?.meta.words).toEqual({ added: 3, removed: 1, before: 4 });
    const history = (await (await s.app.request(`${API}/history/m.md`)).json()) as {
      events: { meta: { words?: unknown } | null }[];
    };
    expect(history.events.at(-1)?.meta?.words).toEqual({ added: 3, removed: 1, before: 4 });
  });
});
