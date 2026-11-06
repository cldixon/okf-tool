import { describe, expect, test } from "bun:test";
import {
  continuesRun,
  dayLabel,
  type Entry,
  entryTime,
  eventNote,
  eventRows,
  groupByDay,
  isLive,
  kindOf,
  type LedgerEvent,
  type LedgerRequest,
  LIVE_MS,
  toEntry,
  whoWorksHere,
  withoutName,
  wordsText,
} from "./src/activity";
import Moment from "./src/Moment.svelte";
import { following } from "./src/paging";
import { localTime, relativeTime } from "./src/ui";
import { folderName } from "./src/urls";
import { draw } from "./test/dom";

// Activity's entry model (app/src/activity.ts): requests told as sentences, days, times.

let seq = 0;
const ev = (op: string, path: string, extra: Partial<LedgerEvent> = {}): LedgerEvent => {
  seq++;
  return {
    seq,
    ts: "2026-10-19T10:00:00Z",
    actor: "claude-code",
    op,
    path,
    prev_hash: "h0",
    hash: "h1",
    page_id: `c:${path}`,
    meta: null,
    ...extra,
  };
};

const req = (events: LedgerEvent[], over: Partial<LedgerRequest> = {}): LedgerRequest => ({
  request_id: `r${seq}`,
  ts: events[0]?.ts ?? "",
  actor: "claude-code",
  note: null,
  by: { person: "cl_dixon", agent: "a1" },
  events,
  ...over,
});

const named: Record<string, string> = {
  "app/reader.md": "Reader",
  "app/diagrams.md": "Diagrams",
  "decisions/cssom.md": "Diagram styles go through the CSSOM",
  "v2/tenancy.md": "Tenancy",
};
/** Titles by path, as the app's useTitleOf gives them (the file name for a page it lacks). */
const titles = (path: string) => named[path] ?? path.replace(/^.*\//, "").replace(/\.md$/, "");

/** The sentence as text, folders as the app names them. */
const text = (e: Entry | null) =>
  (e?.parts ?? [])
    .map((p) => (typeof p === "string" ? p : "folder" in p ? folderName(p.folder) : p.title))
    .join("");

describe("toEntry", () => {
  test("an edit that removed most of the text is a rewrite; a smaller one an edit", () => {
    const words = (added: number, removed: number, before?: number) => ({
      meta: { words: before === undefined ? { added, removed } : { added, removed, before } },
    });
    const one = (w: ReturnType<typeof words>) =>
      toEntry(req([ev("put", "app/reader.md", w)]), titles)?.touched[0]?.what;
    expect(one(words(400, 90, 120))).toBe("rewrote");
    expect(one(words(38, 12, 120))).toBe("edited");
    // From before the ledger kept the size: never called a rewrite.
    expect(one(words(400, 90))).toBe("edited");
  });

  test("one or two changes are named, with their verbs", () => {
    const e = toEntry(
      req([
        ev("put", "app/diagrams.md", { meta: { words: { added: 412, removed: 96 } } }),
        ev("put", "decisions/cssom.md", { prev_hash: null }),
      ]),
      titles,
    );
    expect(text(e)).toBe("edited Diagrams and added Diagram styles go through the CSSOM");
    expect(e?.named).toBe(true);
    expect(e?.touched[0]?.words).toEqual({ added: 412, removed: 96 });
  });

  test("more than two are counted, with their folders", () => {
    const e = toEntry(
      req([
        ev("put", "app/diagrams.md"),
        ev("put", "app/reader.md"),
        ev("put", "decisions/cssom.md", { prev_hash: null }),
      ]),
      titles,
    );
    expect(text(e)).toBe("changed 3 pages in App and Decisions");
    expect(e?.named).toBe(false);
    expect(e?.touched.map((t) => t.what)).toEqual(["edited", "edited", "added"]);
  });

  test("the same verb for all keeps it; many folders are counted", () => {
    const e = toEntry(req([ev("put", "a/x.md"), ev("put", "b/y.md"), ev("put", "c/z.md")]), titles);
    expect(text(e)).toBe("edited 3 pages across 3 folders");
  });

  test("an import", () => {
    const e = toEntry(
      req([
        ev("import", "v2/a.md", { prev_hash: null }),
        ev("import", "v2/b.md", { prev_hash: null }),
        ev("import", "v2/img.png", { prev_hash: null }),
      ]),
      titles,
    );
    expect(text(e)).toBe("imported 3 files in V2");
  });

  test("moves, deletes and several events on one page", () => {
    const moved = toEntry(
      req([ev("move", "app/reader.md", { meta: { from_path: "old/reader.md" } })]),
      titles,
    );
    expect(text(moved)).toBe("moved Reader");
    expect(moved?.touched[0]?.from).toBe("old/reader.md");
    const gone = toEntry(req([ev("delete", "v2/tenancy.md", { hash: null })]), titles);
    expect(text(gone)).toBe("deleted Tenancy");
    const both = toEntry(
      req([
        ev("put", "app/reader.md", { meta: { words: { added: 3, removed: 1 } } }),
        ev("put", "app/reader.md", { meta: { words: { added: 2, removed: 4 } } }),
      ]),
      titles,
    );
    expect(both?.touched).toHaveLength(1);
    expect(both?.touched[0]?.words).toEqual({ added: 5, removed: 5 });
  });

  test("comments and verifications are entries too", () => {
    const thread = (kind: string, body?: string) =>
      ev("comment", "app/reader.md", { meta: { comment: { kind, thread: "t1", body } } });
    const reply = toEntry(
      req([thread("reply", "Cards now show the number."), thread("resolve")]),
      titles,
    );
    expect(text(reply)).toBe("replied on Reader and resolved it");
    expect(reply?.quote).toBe("Cards now show the number.");
    expect(text(toEntry(req([thread("open", "Why?")]), titles))).toBe("opened a thread on Reader");
    const verified = toEntry(
      req(
        [
          ev("verify", "app/reader.md"),
          ev("verify", "v2/tenancy.md"),
          ev("verify", "app/diagrams.md"),
        ],
        { actor: "human:cl_dixon", by: { person: "cl_dixon" } },
      ),
      titles,
    );
    expect(text(verified)).toBe("verified Reader and 2 more");
  });

  test("a note wins over a comment; hiding comments drops a comment-only request", () => {
    const r = req(
      [
        ev("put", "app/reader.md"),
        ev("comment", "app/reader.md", {
          meta: { comment: { kind: "reply", thread: "t", body: "Done" } },
        }),
      ],
      { note: "Mermaid fences drawn by Pele" },
    );
    const e = toEntry(r, titles);
    expect(text(e)).toBe("edited Reader and replied on Reader");
    expect(e?.quote).toBe("Mermaid fences drawn by Pele");
    expect(text(toEntry(r, titles, { hideComments: true }))).toBe("edited Reader");
    const only = req([
      ev("comment", "app/reader.md", { meta: { comment: { kind: "reply", thread: "t" } } }),
    ]);
    expect(toEntry(only, titles, { hideComments: true })).toBeNull();
  });

  test("pages are named by the titles given", () => {
    expect(text(toEntry(req([ev("put", "notes/plan.md")]), titles))).toBe("edited plan");
  });
});

describe("times", () => {
  const now = new Date(2026, 9, 19, 15, 0).getTime();
  const at = (d: number, h: number, m = 0) => new Date(2026, 9, d, h, m).toISOString();

  test("days", () => {
    expect(dayLabel(at(19, 9), now)).toBe("Today");
    expect(dayLabel(at(18, 23), now)).toBe("Yesterday");
    expect(dayLabel(at(12, 9), now)).toBe("Oct 12");
    expect(dayLabel(new Date(2025, 9, 12).toISOString(), now)).toBe("Oct 12, 2025");
  });

  test("grouping keeps order and splits by day", () => {
    const days = groupByDay(
      [{ ts: at(19, 14) }, { ts: at(19, 9) }, { ts: at(18, 18) }, { ts: at(12, 9) }],
      now,
    );
    expect(days.map((d) => [d.label, d.items.length])).toEqual([
      ["Today", 2],
      ["Yesterday", 1],
      ["Oct 12", 1],
    ]);
  });

  test("an entry's time: relative today, the time of day as localTime writes it before", () => {
    expect(entryTime(at(19, 13), now)).toBe("2 hours ago");
    const evening = at(18, 18, 40);
    expect(localTime(evening).endsWith(entryTime(evening, now))).toBe(true);
    expect(entryTime(evening, now)).toMatch(/^\d{1,2}[:.]40/);
  });

  // The one relative time (TEMPRA-131, X-4): never seconds, never UTC.
  test("relativeTime", () => {
    const ago = (ms: number) => new Date(now - ms).toISOString();
    expect(relativeTime(ago(0), now)).toBe("just now");
    expect(relativeTime(ago(10_000), now)).toBe("just now");
    expect(relativeTime(ago(-5_000), now)).toBe("just now"); // a clock a little ahead
    expect(relativeTime(at(19, 14, 59), now)).toBe("1 min ago");
    expect(relativeTime(at(19, 14, 57), now)).toBe("3 min ago");
    expect(relativeTime(at(19, 14), now)).toBe("1 hour ago");
    expect(relativeTime(at(19, 13), now)).toBe("2 hours ago");
    expect(relativeTime(at(19, 0, 30), now)).toBe("14 hours ago");
    expect(relativeTime(at(18, 23), now)).toBe("yesterday");
    expect(relativeTime(at(18, 1), now)).toBe("yesterday");
    expect(relativeTime(at(16, 15), now)).toBe("Oct 16");
    expect(relativeTime(new Date(2025, 7, 1).toISOString(), now)).toBe("Aug 1, 2025");
    expect(relativeTime("not a time", now)).toBe("not a time");
  });

  test("Moment: the relative time, the local date and time on hover", () => {
    const ts = at(19, 13);
    const { host, destroy } = draw(Moment, { ts, now });
    // The attribute names as the DOM has them (lower case: `datetime`).
    expect(host.innerHTML.replace(/<!---->/g, "")).toBe(
      `<time datetime="${ts}" title="${localTime(ts)}">2 hours ago</time>`,
    );
    destroy();
    expect(localTime(ts)).not.toContain("Z");
  });
});

test("who works here", () => {
  expect(whoWorksHere(true, 0, 2)).toBe("You and 2 agents");
  expect(whoWorksHere(true, 1, 3)).toBe("You, 1 other person and 3 agents");
  expect(whoWorksHere(false, 2, 0)).toBe("2 people");
  expect(whoWorksHere(true, 0, 0)).toBe("You");
});

describe("Every event (take 4, TEMPRA-115)", () => {
  test("kinds: a new page is a write, a new version an edit, the rest by their op", () => {
    expect(kindOf({ op: "put", prev_hash: null })).toBe("write");
    expect(kindOf({ op: "put", prev_hash: "h0" })).toBe("edit");
    for (const op of ["move", "delete", "comment", "verify", "revert", "import"]) {
      expect(kindOf({ op, prev_hash: "h0" })).toBe(op);
    }
  });

  test("rows: newest first, who and when on a request's first row, filtered", () => {
    const older = req(
      [ev("put", "app/reader.md", { prev_hash: null }), ev("put", "app/diagrams.md")],
      { request_id: "older", note: "Atoms count as one character" },
    );
    const said = req(
      [
        ev("comment", "app/reader.md", {
          meta: { comment: { kind: "reply", body: "Yes:  images\nand markers" } },
        }),
      ],
      { request_id: "said", actor: "human:ann", by: { person: "ann" } },
    );
    const rows = eventRows([said, older]);
    expect(rows.map((r) => [r.kind, r.event.path, r.lead])).toEqual([
      ["comment", "app/reader.md", true],
      ["edit", "app/diagrams.md", true],
      ["write", "app/reader.md", false],
    ]);
    expect(rows[0]?.note).toBe("Yes: images and markers");
    expect(rows[1]?.note).toBe("Atoms count as one character");
    // Filters: who, kind, and text in the path or the note (case aside).
    expect(eventRows([said, older], { who: "people" }).map((r) => r.request.request_id)).toEqual([
      "said",
    ]);
    expect(eventRows([said, older], { who: "agents" })).toHaveLength(2);
    const writes = eventRows([said, older], { kind: "write" });
    expect(writes.map((r) => [r.event.path, r.lead])).toEqual([["app/reader.md", true]]);
    expect(eventRows([said, older], { q: "DIAGRAMS" })).toHaveLength(1);
    expect(eventRows([said, older], { q: "atoms" })).toHaveLength(2);
    // A request on two pages is listed once.
    expect(eventRows([older, older])).toHaveLength(2);
  });

  test("a move with no note says where it came from", () => {
    const e = ev("move", "delivery/x.md", { meta: { from_path: "decisions/x.md" } });
    expect(eventNote(e, { note: null })).toBe("From decisions/x.md");
    expect(eventNote(e, { note: "Filed under delivery" })).toBe("Filed under delivery");
  });

  test("an agent reads as writing now for a minute after its last write", () => {
    const t = 1_000_000;
    expect(isLive({ at: t }, t + 59_000)).toBe(true);
    expect(isLive({ at: t }, t + LIVE_MS)).toBe(false);
    expect(isLive(null, t)).toBe(false);
  });
});

test("words changed", () => {
  expect(wordsText({ added: 38, removed: 12 })).toBe("+38 −12 words");
  expect(wordsText({ added: 0, removed: 0 })).toBeNull();
  expect(wordsText(null)).toBeNull();
});

describe("Older (paging.ts)", () => {
  const r = (id: string) => req([ev("put", `app/${id}.md`)], { request_id: id });
  const page = (ids: string[], next: number | null) => ({ items: ids.map(r), next });
  const ids = (o: { items: LedgerRequest[] } | null) => o?.items.map((x) => x.request_id);
  const id = (x: LedgerRequest) => x.request_id;

  test("agents' writes reload the first page: what it pushed off stays, nothing goes missing", () => {
    // Older was pressed once: r5 r4 r3, then r2 r1 from the next page.
    const first = page(["r5", "r4", "r3"], 3);
    const older = { after: first, items: [r("r2"), r("r1")], next: null };
    expect(following(older, first, id)).toBe(older);
    // Two agent writes: the reloaded first page is r7 r6 r5; r4 and r3 must not vanish.
    const reloaded = page(["r7", "r6", "r5"], 5);
    const kept = following(older, reloaded, id);
    expect(ids(kept)).toEqual(["r4", "r3", "r2", "r1"]);
    expect(kept?.next).toBeNull();
    expect(kept?.after).toBe(reloaded);
  });

  test("an item the first page no longer holds above its end goes; none in common starts afresh", () => {
    const first = page(["a", "b", "c"], 1);
    const older = { after: first, items: [r("d"), r("e")], next: 9 };
    // "b" was done: the first page now ends with "d", pulled up from the older page.
    expect(ids(following(older, page(["a", "c", "d"], 2), id))).toEqual(["e"]);
    expect(following(older, page(["x", "y", "z"], 4), id)).toBeNull();
    expect(following(null, first, id)).toBeNull();
  });
});

describe("runs on the Summary (TEMPRA-288)", () => {
  const at = (min: number) => new Date(Date.UTC(2026, 10, 5, 12, min)).toISOString();
  const claude = { actor: "claude-code/dev", by: { person: "u1" }, ts: at(30) };

  test("the same actor for the same person within half an hour continues a run", () => {
    expect(continuesRun(undefined, claude)).toBe(false);
    expect(continuesRun(claude, { ...claude, ts: at(5) })).toBe(true);
    expect(continuesRun(claude, { ...claude, ts: at(0) })).toBe(true);
    expect(continuesRun({ ...claude, ts: at(59) }, { ...claude, ts: at(28) })).toBe(false);
    expect(continuesRun(claude, { ...claude, actor: "human:ann" })).toBe(false);
    expect(continuesRun(claude, { ...claude, by: { person: "u2" } })).toBe(false);
  });

  test("a sentence without the name starts with what was done", () => {
    const page = { page: "a.md", title: "A", seq: 1, gone: false, words: null };
    expect(withoutName([" deleted ", page])).toEqual(["Deleted ", page]);
    expect(withoutName([page])).toEqual([page]);
    expect(withoutName([])).toEqual([]);
  });
});
