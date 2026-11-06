import { describe, expect, test } from "bun:test";
import {
  type ActivityDay,
  bulkTitle,
  bulkVerb,
  byPage,
  type DayRow,
  type Doing,
  dayLabel,
  doingText,
  eventNote,
  eventRows,
  folderOptions,
  heardWrites,
  inFolder,
  isLive,
  kindOf,
  type LedgerEvent,
  type LedgerRequest,
  LIVE_MS,
  type LiveWrite,
  type PageRow,
  touchedBy,
  whoWorksHere,
  wordsText,
  workingNow,
} from "./src/activity";
import { type ActedBy, actorView } from "./src/agents";
import type { FeedEvent } from "./src/live";
import Moment from "./src/Moment.svelte";
import PageDayRow from "./src/pages/PageDayRow.svelte";
import WorkingNow from "./src/pages/WorkingNow.svelte";
import { following } from "./src/paging";
import { localTime, relativeTime } from "./src/ui";
import { Urls } from "./src/urls";
import { draw } from "./test/dom";

// Activity's model (app/src/activity.ts): by page (days of page rows, Working now), Every event,
// days and times.

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

describe("touchedBy", () => {
  test("an edit that removed most of the text is a rewrite; a smaller one an edit", () => {
    const words = (added: number, removed: number, before?: number) => ({
      meta: { words: before === undefined ? { added, removed } : { added, removed, before } },
    });
    const one = (w: ReturnType<typeof words>) =>
      touchedBy([ev("put", "app/reader.md", w)], titles)[0]?.what;
    expect(one(words(400, 90, 120))).toBe("rewrote");
    expect(one(words(38, 12, 120))).toBe("edited");
    // From before the ledger kept the size: never called a rewrite.
    expect(one(words(400, 90))).toBe("edited");
  });

  test("moves, deletes, new pages and several events on one page", () => {
    const moved = touchedBy(
      [ev("move", "app/reader.md", { meta: { from_path: "old/reader.md" } })],
      titles,
    );
    expect(moved[0]).toMatchObject({ what: "moved", from: "old/reader.md", title: "Reader" });
    expect(touchedBy([ev("delete", "v2/tenancy.md", { hash: null })], titles)[0]?.what).toBe(
      "deleted",
    );
    expect(touchedBy([ev("put", "a/x.md", { prev_hash: null })], titles)[0]?.what).toBe("added");
    const both = touchedBy(
      [
        ev("put", "app/reader.md", { meta: { words: { added: 3, removed: 1 } } }),
        ev("put", "app/reader.md", { meta: { words: { added: 2, removed: 4 } } }),
      ],
      titles,
    );
    expect(both).toHaveLength(1);
    expect(both[0]?.words).toEqual({ added: 5, removed: 5 });
    expect(both[0]?.page).toBe("c:app/reader.md");
  });
});

// Activity by page (Option B, TEMPRA-308): each day's changes grouped by page.
describe("byPage", () => {
  const now = new Date(2026, 10, 5, 15, 0).getTime();
  const at = (d: number, h: number) => new Date(2026, 10, d, h).toISOString();
  const words = (added: number, removed: number) => ({ meta: { words: { added, removed } } });
  const comment = (kind: string, body?: string) => ({
    meta: { comment: { kind, thread: "t1", body } },
  });
  const ann = { actor: "human:ann", by: { person: "ann" } };
  const rows = (days: ActivityDay[]) =>
    days.map((d) => [d.label, d.rows.map((r) => (r.kind === "page" ? r.title : bulkTitle(r)))]);
  const pageRow = (days: ActivityDay[], i = 0, j = 0) => {
    const row = days[i]?.rows[j];
    if (row?.kind !== "page") throw new Error("not a page row");
    return row;
  };
  /** A row's line as text, names given as the app's AgentName would draw them. */
  const line = (row: PageRow) =>
    row.doings
      .map((d, i) => {
        const t = doingText(d, i === 0);
        const who = d.actor === "human:ann" ? "@ann" : "Claude Code for @dev";
        return `${t.before}${who}${t.after}`;
      })
      .join(" · ");

  test("a day's changes by page, newest first, each person's each kind once", () => {
    // Newest first, as the API pages requests.
    const days = byPage(
      [
        req([ev("put", "app/reader.md", { ts: at(5, 14), ...words(200, 30) })], {
          note: "Split week zero from churned accounts",
        }),
        req(
          [ev("comment", "app/diagrams.md", { ts: at(5, 13), ...comment("open", "Which week?") })],
          ann,
        ),
        req([ev("put", "app/reader.md", { ts: at(5, 11), ...words(52, 12) })], { note: "older" }),
        req([ev("put", "app/diagrams.md", { ts: at(5, 10), ...words(96, 12) })]),
        req([ev("put", "v2/tenancy.md", { ts: at(4, 10) })]),
      ],
      titles,
      now,
    );
    expect(rows(days)).toEqual([
      ["Today", ["Reader", "Diagrams"]],
      ["Yesterday", ["Tenancy"]],
    ]);
    expect(line(pageRow(days))).toBe(
      "Edited twice by Claude Code for @dev, +252 −42 words · “Split week zero from churned accounts”",
    );
    expect(line(pageRow(days, 0, 1))).toBe(
      "@ann commented: “Which week?” · edited by Claude Code for @dev, +96 −12 words",
    );
  });

  test("a request that changed more than three pages is one row, with its folder", () => {
    const pages = ["a", "b", "c", "d", "e"].map((n) =>
      ev("import", `decisions/${n}.md`, { prev_hash: null, ts: at(5, 9) }),
    );
    const days = byPage([req(pages)], titles, now);
    const row = days[0]?.rows[0];
    expect(row?.kind).toBe("bulk");
    if (row?.kind !== "bulk") return;
    expect(bulkTitle(row)).toBe("5 new pages");
    expect(bulkVerb(row)).toBe("Imported by ");
    expect(row.where).toBe("Decisions");
    expect(row.pages.map((p) => p.title)).toEqual(["a", "b"]);
    const moved = byPage(
      [req(["a/x.md", "b/y.md", "c/z.md", "c/w.md"].map((p) => ev("move", p, { ts: at(5, 9) })))],
      titles,
      now,
    )[0]?.rows[0];
    if (moved?.kind !== "bulk") throw new Error("not a bulk row");
    expect(bulkTitle(moved)).toBe("4 pages moved");
    expect(bulkVerb(moved)).toBe("Moved by ");
    expect(moved.where).toBe("3 folders");
    // Three pages are still told page by page.
    const three = byPage(
      [req(["a/x.md", "b/y.md", "c/z.md"].map((p) => ev("put", p, { ts: at(5, 9) })))],
      titles,
      now,
    );
    expect(three[0]?.rows.map((r) => r.kind)).toEqual(["page", "page", "page"]);
  });

  test("people read checked, never verified (TEMPRA-295)", () => {
    const days = byPage([req([ev("verify", "app/reader.md", { ts: at(5, 9) })], ann)], titles, now);
    const row = pageRow(days);
    expect(row.doings[0]?.did).toBe("checked");
    expect(line(row)).toBe("Checked by @ann");
    expect(line(row)).not.toContain("verif");
    expect(doingText({ ...(row.doings[0] as Doing), times: 2 }, false).before).toBe(
      "checked twice by ",
    );
  });

  test("comments: replies, resolves and the newest comment quoted", () => {
    const days = byPage(
      [
        req(
          [
            ev("comment", "app/reader.md", { ts: at(5, 9), ...comment("reply", "First") }),
            ev("comment", "app/reader.md", { ts: at(5, 9), ...comment("reply", "Second") }),
            ev("comment", "app/reader.md", { ts: at(5, 9), ...comment("resolve") }),
          ],
          ann,
        ),
      ],
      titles,
      now,
    );
    expect(line(pageRow(days))).toBe("@ann resolved a thread · @ann replied twice: “Second”");
  });

  test("a deleted page is gone; a library thread is a row for the library", () => {
    const days = byPage(
      [
        req([ev("delete", "v2/tenancy.md", { hash: null, ts: at(5, 10) })]),
        req([ev("comment", "", { page_id: "lib", ts: at(5, 9), ...comment("open", "Hi") })], ann),
      ],
      titles,
      now,
    );
    expect(pageRow(days)).toMatchObject({ title: "Tenancy", gone: true });
    expect(line(pageRow(days))).toBe("Deleted by Claude Code for @dev");
    expect(pageRow(days, 0, 1)).toMatchObject({ title: "The library", path: "" });
  });

  test("Agents or People, and a request listed twice counts once", () => {
    const mine = req([ev("put", "app/reader.md", { ts: at(5, 9) })]);
    const theirs = req([ev("verify", "v2/tenancy.md", { ts: at(5, 8) })], ann);
    expect(rows(byPage([mine, mine, theirs], titles, now, "agents"))).toEqual([
      ["Today", ["Reader"]],
    ]);
    expect(rows(byPage([mine, theirs], titles, now, "people"))).toEqual([["Today", ["Tenancy"]]]);
    expect(pageRow(byPage([mine, mine], titles, now)).doings[0]?.times).toBe(1);
    expect(byPage([req([])], titles, now)).toEqual([]);
  });
});

describe("the folder filter", () => {
  test("every folder in the index, in the tree's order, by readable name", () => {
    const index = [
      { path: "app", kind: "dir" as const },
      { path: "app/reader.md", kind: "page" as const },
      { path: "app-notes/x.md", kind: "page" as const },
      { path: "v2/deep/y.md", kind: "page" as const },
    ];
    expect(folderOptions(index, "")).toEqual([
      { value: "", label: "All folders" },
      { value: "app", label: "App" },
      { value: "app-notes", label: "App notes" },
      { value: "v2", label: "V2" },
      { value: "v2/deep", label: "V2 / Deep" },
    ]);
    // A folder in the URL the index lacks is still offered.
    expect(folderOptions([], "gone/")).toEqual([
      { value: "", label: "All folders" },
      { value: "gone", label: "Gone" },
    ]);
  });

  test("inFolder", () => {
    expect(inFolder("", "a/b.md")).toBe(true);
    expect(inFolder("app", "app/reader.md")).toBe(true);
    expect(inFolder("app/", "app")).toBe(true);
    expect(inFolder("app", "app-notes/x.md")).toBe(false);
    expect(inFolder("app", null)).toBe(false);
  });
});

describe("Working now (Option B)", () => {
  const event = (actor: string, path: string, over: Partial<FeedEvent> = {}): FeedEvent => ({
    seq: ++seq,
    ts: "2026-11-05T10:00:00Z",
    actor,
    request_id: `r${seq}`,
    op: "put",
    path,
    page_id: `c:${path}`,
    hash: "h",
    note: null,
    from_path: null,
    ...over,
  });

  test("each agent's newest write, several at once; not people, comments or deletes", () => {
    let writes = heardWrites(new Map(), [event("claude-code/dev", "app/a.md")], 1000);
    writes = heardWrites(
      writes,
      [
        event("claude-code/dev", "app/b.md"),
        event("claude/ann", "v2/c.md", { by: { person: "ann", agent: "x" } }),
        event("human:ann", "v2/d.md"),
        event("codex/dev", "v2/e.md", { op: "comment" }),
        event("codex/dev", "v2/f.md", { op: "delete" }),
      ],
      2000,
    );
    expect([...writes.values()].map((w) => [w.actor, w.path])).toEqual([
      ["claude-code/dev", "app/b.md"],
      ["claude/ann", "v2/c.md"],
    ]);
    // The same agent for another person is another writer.
    const other = heardWrites(
      writes,
      [event("claude-code/dev", "x.md", { by: { person: "u2", agent: "y" } })],
      3000,
    );
    expect(other.size).toBe(3);
  });

  test("newest first, gone after LIVE_MS, none for People, only in the folder", () => {
    const w = (path: string, at: number): LiveWrite => ({
      actor: `agent/${path}`,
      by: null,
      path,
      seq: 1,
      at,
    });
    const writes = [w("app/a.md", 1000), w("v2/b.md", 5000), w("app/c.md", 3000)];
    const now = 6000;
    expect(workingNow(writes, now).map((x) => x.path)).toEqual(["v2/b.md", "app/c.md", "app/a.md"]);
    expect(workingNow(writes, 1000 + LIVE_MS).map((x) => x.path)).toEqual(["v2/b.md", "app/c.md"]);
    expect(workingNow(writes, now, { who: "people" })).toEqual([]);
    expect(workingNow(writes, now, { prefix: "app" }).map((x) => x.path)).toEqual([
      "app/c.md",
      "app/a.md",
    ]);
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

describe("by page, drawn", () => {
  const urls = new Urls("dev", "lib");
  const view = (actor: string, by: ActedBy | null) => actorView(actor, by, {}, "human:me");
  const now = Date.now();
  const ts = new Date(now).toISOString();

  test("a page's row: its title and folder, the dot while written, one line; no time", () => {
    const days = byPage(
      [
        req([ev("verify", "app/reader.md", { ts })], { actor: "human:me", by: { person: "me" } }),
        req([ev("put", "app/reader.md", { ts })], { note: "Tightened" }),
      ],
      titles,
      now,
    );
    const row = days[0]?.rows[0] as PageRow;
    const d = draw(PageDayRow, { row, urls, view, writing: true });
    const article = d.host.querySelector("article.change-row.bare.activity-page");
    expect(article).not.toBeNull();
    expect(article?.querySelector("a.activity-page-title")?.getAttribute("href")).toBe(
      "/dev/lib/app/reader.md",
    );
    expect(article?.querySelector(".activity-page-folder")?.textContent).toBe("App");
    expect(article?.querySelector(".change-dot.live")).not.toBeNull();
    expect(article?.querySelector("time, .change-row-when")).toBeNull();
    // The signed-in person reads as "you" mid-line; people read "checked".
    expect(article?.querySelector(".activity-page-line")?.textContent).toMatch(
      /^Checked by you · edited by .+ · “Tightened”$/,
    );
    d.destroy();
  });

  test("a bulk row names two pages and how many more", () => {
    const pages = ["a", "b", "c", "d", "e"].map((n) =>
      ev("import", `decisions/${n}.md`, { prev_hash: null, ts }),
    );
    const row = byPage([req(pages)], titles, now)[0]?.rows[0] as DayRow;
    const d = draw(PageDayRow, { row, urls, view });
    expect(d.host.querySelector(".activity-page-title")?.textContent).toBe("5 new pages");
    expect(d.host.querySelector(".activity-page-folder")?.textContent).toBe("Decisions");
    expect(d.host.querySelector(".activity-page-line")?.textContent).toMatch(
      /^Imported by .+ · a, b and 3 more$/,
    );
    d.destroy();
  });

  test("Working now: one line per agent with the pulsing dot, nothing when nobody writes", () => {
    const working: LiveWrite[] = [
      { actor: "claude-code/dev", by: null, path: "app/reader.md", seq: 2, at: now },
      { actor: "claude/ann", by: null, path: "v2/tenancy.md", seq: 1, at: now - 1000 },
    ];
    const d = draw(WorkingNow, { urls, working, view, titleOf: titles });
    expect(d.host.querySelector(".activity-working-title")?.textContent).toBe("Working now");
    const lines = [...d.host.querySelectorAll(".activity-working-list li")];
    expect(lines.map((l) => l.textContent)).toEqual([
      "Claude Code is editing Reader",
      "Claude is editing Tenancy",
    ]);
    expect(lines.every((l) => l.querySelector(".change-dot.live"))).toBe(true);
    d.destroy();
    const none = draw(WorkingNow, { urls, working: [], view, titleOf: titles });
    expect(none.host.querySelector(".activity-working-title")).toBeNull();
    none.destroy();
  });
});
