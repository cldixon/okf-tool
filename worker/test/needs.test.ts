import { describe, expect, test } from "bun:test";
import type { Mention } from "../src/store/comments";
import { LibraryStore, type RequestContext } from "../src/store/store";
import { API, ORIGIN, setup } from "./harness";
import { bunSqlHandle } from "./sqlite";

let n = 0;
/** A request by `actor`, for `person` (and their `agent`) when given, as the Worker records it. */
const ctx = (actor: string, person?: string, agent?: string): RequestContext => ({
  actor,
  request_id: `req-${++n}`,
  by: person ? (agent ? { person, agent } : { person }) : null,
});
const ana = () => ctx("human:ana", "u_ana");
const anasAgent = () => ctx("claude-code/ana", "u_ana", "a_ana");
const bob = () => ctx("human:bob", "u_bob");
const agent = () => ctx("claude-code/bob", "u_bob", "a_bob");
const ME = { person: "u_ana", actor: "human:ana" };

function newStore() {
  let t = Date.parse("2026-10-05T12:00:00Z");
  return new LibraryStore(bunSqlHandle(), {
    now: () => {
      t += 1000;
      return new Date(t);
    },
  });
}

const doc = (title: string, fm = "", body = "Revenue minus cost.") =>
  `---\ntype: Metric\ntitle: ${title}\ndescription: A metric.\n${fm}---\n# ${title}\n\n${body}\n`;

/** Writes a page, over its current version when there is one. */
function write(s: LibraryStore, c: RequestContext, path: string, content = doc(path)) {
  const if_match = s.pages().items.find((i) => i.path === path)?.hash ?? null;
  return s.apply(c, [{ op: "write", path, content, if_match }]);
}

function open(
  s: LibraryStore,
  c: RequestContext,
  path: string,
  body: string,
  mentions?: Mention[],
) {
  return s.comment(c, { kind: "open", path, body, mentions }).thread.id;
}

const reply = (s: LibraryStore, c: RequestContext, thread: string, body: string) =>
  s.comment(c, { kind: "reply", thread, body });

describe("Needs you: waiting on your reply", () => {
  test("threads the person took part in or was mentioned in, the last comment not theirs", () => {
    const s = newStore();
    write(s, agent(), "metrics/margin.md", doc("Margin", "", "Margin is revenue minus cost."));
    write(s, agent(), "metrics/churn.md");
    // Ana asked, an agent answered: waiting on her.
    const asked = open(s, ana(), "metrics/margin.md", "Is this right?");
    reply(s, agent(), asked, "Yes, per the standard.");
    // Ana has the last word: not waiting on her.
    const answered = open(s, bob(), "metrics/margin.md", "Check the source.");
    reply(s, ana(), answered, "Done.");
    // Bob mentioned her: waiting on her, though she never wrote in it.
    const mentioned = open(s, bob(), "metrics/churn.md", "@ana is this current?", [
      { user: "u_ana", handle: "ana" },
    ]);
    // Bob's thread without her: not hers.
    open(s, bob(), "metrics/churn.md", "Typo in the title.");
    // Resolved: nothing to answer.
    const resolved = open(s, ana(), "metrics/churn.md", "Add a source.");
    reply(s, agent(), resolved, "Added.");
    s.comment(bob(), { kind: "resolve", thread: resolved });

    const needs = s.needs(ME);
    expect(needs.replies.map((r) => r.thread)).toEqual([mentioned, asked]);
    expect(needs.replies[1]).toMatchObject({
      path: "metrics/margin.md",
      title: "Margin",
      quote: null,
      last: {
        actor: "claude-code/bob",
        by: { person: "u_bob", agent: "a_bob" },
        body: "Yes, per the standard.",
      },
    });
    expect(needs.replies[0]?.last.by).toEqual({ person: "u_bob" });
    // Bob's side: Ana replied last on his thread, and his agent answered Ana's for him.
    expect(s.needs({ person: "u_bob", actor: "human:bob" }).replies.map((r) => r.thread)).toEqual([
      answered,
      asked,
    ]);
  });

  test("the person's agents count as taking part, and their replies are news to them", () => {
    const s = newStore();
    write(s, agent(), "metrics/margin.md", doc("Margin", "", "Margin is revenue minus cost."));
    // Her agent opened it for her; Bob answered.
    const forHer = open(s, anasAgent(), "metrics/margin.md", "Should this cite the standard?");
    reply(s, bob(), forHer, "It should.");
    // She asked, her own agent answered last: still hers to answer.
    const herAgent = s.comment(ana(), {
      kind: "open",
      path: "metrics/margin.md",
      body: "Tighten this.",
      anchor: { quote: "revenue minus cost" },
    }).thread.id;
    reply(s, anasAgent(), herAgent, "Tightened.");
    const needs = s.needs(ME);
    expect(needs.replies.map((r) => r.thread)).toEqual([herAgent, forHer]);
    expect(needs.replies[0]?.quote).toBe("revenue minus cost");
  });

  test("comments from before `by` was kept are told apart by actor", () => {
    const s = newStore();
    write(s, ctx("claude-code/old"), "metrics/margin.md");
    const asked = open(s, ctx("human:ana"), "metrics/margin.md", "Is this right?");
    open(s, ctx("human:ana"), "metrics/margin.md", "A note to self.");
    reply(s, ctx("claude-code/old"), asked, "Yes.");
    expect(s.needs(ME).replies.map((r) => r.thread)).toEqual([asked]);
    expect(s.needs({ person: null, actor: "human:ana" }).replies.map((r) => r.thread)).toEqual([
      asked,
    ]);
    // Nobody to compare with: nothing is theirs, so nothing waits on them.
    expect(s.needs({ person: null, actor: null }).replies).toEqual([]);
  });
});

describe("Needs you: to verify", () => {
  test("verified then changed; the never verified are counted, the current verified left out", () => {
    const s = newStore();
    write(s, agent(), "a.md");
    write(s, agent(), "b.md");
    write(s, agent(), "c.md");
    s.verify(ana(), "b.md");
    s.verify(ana(), "c.md");
    write(s, agent(), "b.md", doc("b.md", "", "Revenue minus cost, monthly."));
    write(s, anasAgent(), "b.md", doc("b.md", "", "Revenue minus cost, quarterly."));

    const { verify, unverified, count, replies } = s.needs(ME);
    expect(verify.total).toBe(1);
    expect(verify.next_offset).toBeNull();
    expect(verify.items.map((i) => i.path)).toEqual(["b.md"]);
    const [b] = verify.items;
    expect(b).toMatchObject({
      title: "b.md",
      actor: "claude-code/ana",
      by: { person: "u_ana", agent: "a_ana" },
      verified: { actor: "human:ana" },
      changes: 2,
    });
    expect(b?.verified.seq).toBeLessThan(b?.seq ?? 0);
    // Never verified (TEMPRA-111): a standing, not a request; counted, and not in the sidebar's.
    expect(unverified).toEqual({ total: 1 });
    expect(count).toBe(replies.length + verify.total);
    // Together, the health summary's (which counts any verification).
    expect(s.health().unverified.total).toBe(verify.total + unverified.total);
  });

  test("a move is not a change, and only a person's verification counts", () => {
    const s = newStore();
    write(s, agent(), "m/a.md");
    write(s, agent(), "p.md");
    s.verify(ana(), "m/a.md");
    // Moved after it was verified: still the version a person verified.
    s.apply(agent(), [{ op: "move", path: "m/a.md", to: "n/a.md" }]);
    // A process vouching for a page is not a person verifying it.
    s.verify(ctx("process:recheck"), "p.md");
    expect(s.needs(ME).verify.items).toEqual([]);
    expect(s.needs(ME).unverified.total).toBe(1);
    // The health summary counts any verification, a process's too.
    expect(s.health().unverified.total).toBe(0);
  });

  test("paged newest first by offset", () => {
    const s = newStore();
    for (const p of ["a.md", "b.md", "c.md", "d.md", "e.md"]) {
      write(s, agent(), p);
      s.verify(ana(), p);
    }
    for (const p of ["a.md", "b.md", "c.md", "d.md", "e.md"]) {
      write(s, agent(), p, doc(p, "", `Changed after ${p} was verified.`));
    }
    const first = s.needs(ME, { limit: 2 }).verify;
    expect(first.total).toBe(5);
    expect(first.items.map((i) => i.path)).toEqual(["e.md", "d.md"]);
    expect(first.next_offset).toBe(2);
    const last = s.needs(ME, { limit: 2, offset: 4 }).verify;
    expect(last.items.map((i) => i.path)).toEqual(["a.md"]);
    expect(last.next_offset).toBeNull();
    expect(s.needs(ME).verify.items).toHaveLength(5);
  });
});

describe("Needs you: the agents' housekeeping", () => {
  test("housekeeping counts the work queue's, stale pages among it, never a person's count", () => {
    const s = newStore();
    write(s, agent(), "soon.md", doc("Soon", "stale_after: 2026-10-12T00:00:00Z\n"));
    write(s, agent(), "past.md", doc("Past", "stale_after: 2026-10-01T00:00:00Z\n"));
    write(s, agent(), "later.md", doc("Later", "stale_after: 2027-10-01T00:00:00Z\n"));
    write(s, agent(), "links.md", doc("Links", "", "See [gone](/gone.md)."));

    const needs = s.needs(ME);
    expect(needs).not.toHaveProperty("stale");
    const work = s.work().counts;
    expect(work.stale).toBe(1);
    expect(needs.housekeeping).toEqual({
      stale: 1,
      lint: work.lint ?? 0,
      structure: work.structure ?? 0,
      broken_link: 1,
      total: 1 + (work.lint ?? 0) + (work.structure ?? 0) + 1,
    });
    expect(needs.verify.total).toBe(0);
    expect(needs.unverified.total).toBe(4);
    expect(needs.count).toBe(0);
  });
});

describe("GET /needs", () => {
  const call = (app: ReturnType<typeof setup>["app"], path: string, body?: unknown) =>
    app.request(`${API}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { Origin: ORIGIN, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  test("answers for the signed-in person, and for a token's person", async () => {
    const s = setup();
    const put = await s.req("/files/metrics/margin.md", {
      method: "PUT",
      headers: { "Content-Type": "text/markdown" },
      body: doc("Margin"),
    });
    expect(put.status).toBeLessThan(300);
    const opened = await call(s.app, "/comments", { path: "metrics/margin.md", body: "Right?" });
    const { thread } = (await opened.json()) as { thread: { id: string } };
    // The owner wrote last: nothing to answer yet.
    const before = (await (await call(s.app, "/needs")).json()) as {
      replies: unknown[];
      verify: { total: number; items: { path: string }[] };
      unverified: { total: number };
    };
    expect(before.replies).toEqual([]);
    expect(before.verify.items).toEqual([]);
    expect(before.unverified.total).toBe(1);

    const answered = await s.req(`/comments/${thread.id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body: "Yes." }),
    });
    expect(answered.status).toBe(200);
    const after = (await (await call(s.app, "/needs?limit=1")).json()) as {
      replies: { thread: string; last: { actor: string; body: string } }[];
      verify: { next_offset: number | null };
      count: number;
    };
    expect(after.replies).toMatchObject([
      { thread: thread.id, last: { actor: "claude-code/test", body: "Yes." } },
    ]);
    expect(after.count).toBe(1);
    // The owner's human: token is the same person.
    const human = (await (await s.req("/needs", { token: "human" })).json()) as {
      replies: { thread: string }[];
    };
    expect(human.replies.map((r) => r.thread)).toEqual([thread.id]);
  });

  test("is not found for a stranger, and refuses a bad page", async () => {
    const s = setup();
    const other = await s.stranger();
    expect((await call(other.app, "/needs")).status).toBe(404);
    expect((await call(s.app, "/needs?limit=x")).status).toBe(400);
  });
});
