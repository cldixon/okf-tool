import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { LibraryStore } from "../src/store/store";
import { API, ORIGIN, setup } from "./harness";
import { bunSqlHandle } from "./sqlite";

/**
 * TEMPRA-302: the home's Recently changed is the last five pages edited, however many comments,
 * checks and other requests came after them (it read them from the newest 20 requests, so
 * comments pushed the edits out of the window and the list shrank with no new write).
 */

type S = ReturnType<typeof setup>;
type Changed = { pages: { path: string; op: string; actor: string; ts: string; seq: number }[] };

const page = (title: string) =>
  `---\ntype: Note\ntitle: ${title}\ndescription: A note.\n---\n# ${title}\n\nSome text.\n`;

async function hashOf(s: S, path: string) {
  const r = await s.req(`/files/${path}`, { headers: { Accept: "application/json" } });
  return r.status === 200 ? ((await r.json()) as { hash: string }).hash : null;
}

async function put(s: S, path: string, title = path) {
  const hash = await hashOf(s, path);
  const r = await s.req(`/files/${path}`, {
    method: "PUT",
    headers: { "Content-Type": "text/markdown", ...(hash ? { "If-Match": `"${hash}"` } : {}) },
    body: page(title),
  });
  expect(r.status).toBeLessThan(300);
}

function post(s: S, path: string, body: unknown) {
  return s.app.request(`${API}${path}`, {
    method: "POST",
    headers: { Origin: ORIGIN, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function changed(s: S, limit?: number) {
  const r = await s.app.request(`${API}/changed${limit ? `?limit=${limit}` : ""}`);
  expect(r.status).toBe(200);
  return ((await r.json()) as Changed).pages.map((p) => p.path);
}

/** Pages paths as the old home read them: content events in the newest 20 requests. */
async function fromNewestRequests(s: S) {
  const r = await s.app.request(`${API}/requests?limit=20`);
  const { requests } = (await r.json()) as {
    requests: { events: { op: string; path: string }[] }[];
  };
  const seen: string[] = [];
  for (const q of requests)
    for (const e of [...q.events].reverse())
      if (["put", "import", "move", "revert"].includes(e.op) && !seen.includes(e.path))
        seen.push(e.path);
  return seen.slice(0, 5);
}

describe("Recently changed (TEMPRA-302)", () => {
  test("comments after the edits do not shrink it", async () => {
    const s = setup();
    for (let i = 1; i <= 6; i++) await put(s, `notes/p${i}.md`);
    const five = ["notes/p6.md", "notes/p5.md", "notes/p4.md", "notes/p3.md", "notes/p2.md"];
    expect(await changed(s)).toEqual(five);
    // Nineteen comments and no write: the newest 20 requests now hold one edit.
    for (let i = 0; i < 19; i++) {
      const r = await post(s, "/comments", { path: "notes/p1.md", body: `Comment ${i}` });
      expect(r.status).toBe(201);
    }
    expect(await fromNewestRequests(s)).toEqual(["notes/p6.md"]);
    expect(await changed(s)).toEqual(five);
  });

  test("each page once, by its path now; checks, deletes and attachments take no slot", async () => {
    const s = setup();
    for (let i = 1; i <= 6; i++) await put(s, `notes/p${i}.md`);
    // p6 edited again and again: listed once.
    for (let i = 0; i < 4; i++) await put(s, "notes/p6.md", `P6 v${i}`);
    // A check on p1 changes no text: p1 stays where its last edit put it.
    expect((await post(s, "/verify/notes/p1.md", {})).status).toBe(200);
    // p2 moved: listed at its new path, as of the move.
    const moved = await s.req("/files/notes/p2.md/move", {
      method: "POST",
      body: JSON.stringify({ to: "notes/two.md" }),
    });
    expect(moved.status).toBe(200);
    // p5 deleted: gone from the list.
    const del = await s.req("/files/notes/p5.md", {
      method: "DELETE",
      headers: { "If-Match": (await hashOf(s, "notes/p5.md")) ?? "" },
    });
    expect(del.status).toBe(200);
    // An attachment is not a page.
    const att = await s.req("/files/notes/a.txt", {
      method: "PUT",
      headers: { "Content-Type": "text/plain" },
      body: "bytes",
    });
    expect(att.status).toBeLessThan(300);

    expect(await changed(s)).toEqual([
      "notes/two.md",
      "notes/p6.md",
      "notes/p4.md",
      "notes/p3.md",
      "notes/p1.md",
    ]);
    expect(await changed(s, 2)).toEqual(["notes/two.md", "notes/p6.md"]);
  });

  test("who changed it and when, from the change itself", async () => {
    const s = setup();
    await put(s, "a.md");
    await post(s, "/comments", { path: "a.md", body: "A person's comment." });
    const r = await s.app.request(`${API}/changed`);
    const { pages } = (await r.json()) as Changed;
    expect(pages).toHaveLength(1);
    expect(pages[0]).toMatchObject({ path: "a.md", op: "put", actor: "claude-code/test" });
  });

  test("indexed: pages by last_seq, and each page's last change by its own events", () => {
    const db = new Database(":memory:");
    new LibraryStore(bunSqlHandle(db));
    const plan = (q: string) =>
      (db.query(`EXPLAIN QUERY PLAN ${q}`).all() as { detail: string }[])
        .map((r) => r.detail)
        .join("; ");
    expect(
      plan(
        "SELECT path, page_id, last_seq FROM paths WHERE last_seq < 9 AND kind = 'page' ORDER BY last_seq DESC LIMIT 20",
      ),
    ).toContain("USING INDEX paths_last");
    const events = plan(
      "SELECT * FROM events WHERE page_id = 'x' AND op != 'comment' AND op IN ('put', 'import', 'move', 'revert') ORDER BY seq DESC LIMIT 1",
    );
    expect(events).toMatch(/USING INDEX events_(content|page)/);
    expect(events).not.toContain("TEMP B-TREE");
  });

  test("fewer pages than five: all of them", async () => {
    const s = setup();
    expect(await changed(s)).toEqual([]);
    await put(s, "a.md");
    await put(s, "b.md");
    expect(await changed(s)).toEqual(["b.md", "a.md"]);
  });
});
