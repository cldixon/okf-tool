import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { flushSync } from "svelte";
import { type FeedEvent, feedOf, LibraryFeed } from "./src/live";
import { activeFolders, type PresenceMessage, PresenceStore } from "./src/presence";
import Tree from "./src/Tree.svelte";
import type { OutlineFile } from "./src/tree";
import { Urls } from "./src/urls";
import { draw, settle } from "./test/dom";

// Agents' presence (TEMPRA-219): what an agent reads and writes now, from the feed, as a shimmer
// on the tree's rows (no words beside it; a hover names the agent), fading after a few seconds.

const BY = { person: "u1", agent: "agt_1" };

const reading = (paths: string[], actor = "claude-code/dev"): PresenceMessage => ({
  type: "presence",
  kind: "reading",
  actor,
  by: BY,
  paths,
});

const write = (seq: number, path: string, actor = "claude-code/dev"): FeedEvent => ({
  seq,
  ts: "2026-10-30T00:00:00Z",
  actor,
  request_id: `r${seq}`,
  op: "put",
  path,
  page_id: `c${seq}`,
  hash: "h",
  note: null,
  from_path: null,
  by: BY,
});

describe("the presence store (presence.ts)", () => {
  test("the most recent per file; people never; folders above a marked file", () => {
    let now = 1000;
    const p = new PresenceStore(() => now, 8000);
    p.add(reading(["a/b/one.md", "two.md"]));
    p.add(reading(["three.md"], "human:dev"));
    expect([...p.active().keys()]).toEqual(["a/b/one.md", "two.md"]);
    now = 2000;
    p.events([write(1, "two.md")]);
    expect(p.active().get("two.md")).toMatchObject({ kind: "writing", at: 2000 });
    now = 3000;
    p.add(reading(["two.md"]));
    expect(p.active().get("two.md")).toMatchObject({ kind: "reading", at: 3000 });
    expect([...activeFolders(p.active()).keys()].sort()).toEqual(["a", "a/b"]);
    // A folder holds the most recent presence inside it, for its tooltip.
    now = 4000;
    p.events([write(2, "a/other.md")]);
    expect(activeFolders(p.active()).get("a")).toMatchObject({ kind: "writing", at: 4000 });
    expect(activeFolders(p.active()).get("a/b")).toMatchObject({ kind: "reading", at: 1000 });
  });

  test("an agent's write is writing; a person's, a comment or a delete is not", () => {
    const p = new PresenceStore(() => 0, 8000);
    p.events([
      write(1, "a.md"),
      write(2, "b.md", "human:dev"),
      { ...write(3, "c.md"), op: "comment" },
      { ...write(4, "d.md"), op: "delete" },
      { ...write(5, "e.md"), op: "move", from_path: "two.md" },
    ]);
    expect([...p.active().entries()].map(([k, v]) => [k, v.kind])).toEqual([
      ["a.md", "writing"],
      ["e.md", "writing"],
    ]);
  });

  test("a mark fades after its time, and the watchers hear it go", async () => {
    const p = new PresenceStore(Date.now, 30);
    let heard = 0;
    p.watch(() => heard++);
    p.add(reading(["a.md"]));
    expect(heard).toBe(1);
    expect(p.active().has("a.md")).toBe(true);
    await new Promise((r) => setTimeout(r, 120));
    expect(heard).toBe(2);
    expect(p.active().size).toBe(0);
  });

  test("the feed keeps presence apart from the ledger: no cursor moves, no listener hears it", () => {
    (globalThis as { location?: unknown }).location ??= { href: "http://localhost/" };
    const feed = new LibraryFeed(new Urls("ann", "presence"), () => ({}) as WebSocket);
    const heard: number[] = [];
    feed.subscribe({ events: (e) => heard.push(...e.map((x) => x.seq)), reset: () => {} });
    feed.receive({ type: "hello", head: 3 });
    feed.receive(reading(["x.md"]));
    expect(feed.presence.active().get("x.md")?.kind).toBe("reading");
    feed.receive({ type: "events", head: 4, events: [write(4, "y.md")] });
    expect(heard).toEqual([4]);
    expect(feed.presence.active().get("y.md")?.kind).toBe("writing");
  });
});

class NoSocket {
  static OPEN = 1;
  readyState = 0;
  addEventListener() {}
  removeEventListener() {}
  close() {}
  send() {}
}
const realSocket = globalThis.WebSocket;
const realFetch = globalThis.fetch;
beforeEach(() => {
  globalThis.WebSocket = NoSocket as unknown as typeof WebSocket;
  localStorage.clear();
  // The library's agents, so a hover names the agent for its person.
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const body = String(input).includes("/agents")
      ? {
          contributors: [
            {
              person: "dev",
              agent: { id: "agt_1", name: "Claude Code", platform: null, client: null },
              actor: "claude-code/dev",
              requests: 1,
              last_ts: "2026-10-30T00:00:00Z",
            },
          ],
        }
      : {};
    return new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.WebSocket = realSocket;
  globalThis.fetch = realFetch;
});

const OUTLINE: OutlineFile[] = [
  { path: "guides/start.md", kind: "page", title: "Start", seq: 1 },
  { path: "guides/deep/more.md", kind: "page", title: "More", seq: 2 },
  { path: "top.md", kind: "page", title: "Top", seq: 3 },
];

describe("the tree shows presence (Tree.svelte)", () => {
  test("a marked name shimmers with no words shown; a hover names the agent", async () => {
    const urls = new Urls("dev", "presence-tree");
    const t = draw(Tree, {
      urls,
      file: null,
      dir: null,
      files: OUTLINE,
      failed: false,
      onRetry: () => {},
    });
    await settle(10);
    expect(t.host.querySelector("a.presence")).toBeNull();
    feedOf(urls).receive(reading(["guides/deep/more.md"]));
    flushSync();
    const row = t.host.querySelector<HTMLAnchorElement>('a[data-path="guides/deep/more.md"]');
    expect(row?.classList.contains("presence")).toBe(true);
    expect(row?.dataset.presence).toBe("reading");
    // The name alone is shown; the words are for screen readers only.
    expect(row?.textContent).toBe("More");
    const hidden = row?.closest(".tree-row")?.querySelector(".visually-hidden");
    expect(hidden?.textContent).toBe("an agent is reading");
    expect(row?.getAttribute("title")).toBe("More: Claude Code for @dev is reading");
    const top = t.host.querySelector<HTMLAnchorElement>('a[data-path="top.md"]');
    expect(top?.classList.contains("presence")).toBe(false);
    expect(top?.getAttribute("title")).toBe("Top");
    // A write shimmers too, and says so on hover.
    feedOf(urls).receive({ type: "events", head: 9, events: [write(9, "top.md")] });
    flushSync();
    expect(top?.dataset.presence).toBe("writing");
    expect(top?.getAttribute("title")).toBe("Top: Claude Code for @dev is writing");
    t.destroy();
  });

  test("a closed folder shimmers its name; opened, the shimmer moves down to what holds it", async () => {
    const urls = new Urls("dev", "presence-folder");
    const t = draw(Tree, {
      urls,
      file: null,
      dir: null,
      files: OUTLINE,
      failed: false,
      onRetry: () => {},
    });
    await settle(10);
    /** A folder's row by its name, and whether it shimmers. */
    const folder = (name: string) =>
      t.host.querySelector<HTMLButtonElement>(
        `button.tree-name[aria-expanded]:is([title="${name}"], [title^="${name}: "])`,
      );
    const shimmers = (el: Element | null | undefined) =>
      el?.closest(".tree-row")?.classList.contains("presence") ?? false;
    const page = () => t.host.querySelector('a[data-path="guides/deep/more.md"]');
    // Close Deep, then Guides: the page being read is two closed folders down.
    folder("Deep")?.click();
    flushSync();
    folder("Guides")?.click();
    flushSync();
    feedOf(urls).receive(reading(["guides/deep/more.md"]));
    flushSync();
    // No ring, dot or circle: the closed folder's own name shimmers, as a page's would.
    expect(t.host.querySelector(".presence-mark")).toBeNull();
    expect(shimmers(folder("Guides"))).toBe(true);
    expect(folder("Guides")?.dataset.presence).toBe("reading");
    expect(folder("Guides")?.textContent).toBe("Guides");
    expect(folder("Guides")?.getAttribute("title")).toBe(
      "Guides: Claude Code for @dev is reading in here",
    );
    expect(
      folder("Guides")?.closest(".tree-row")?.querySelector(".visually-hidden")?.textContent,
    ).toBe("an agent is reading in here");
    // Opened mid-shimmer: it stops, and the closed folder below that holds the page takes it.
    folder("Guides")?.click();
    flushSync();
    expect(shimmers(folder("Guides"))).toBe(false);
    expect(folder("Guides")?.getAttribute("title")).toBe("Guides");
    expect(shimmers(folder("Deep"))).toBe(true);
    expect(page()).toBeNull();
    // Opened again: the page itself shimmers, and no open folder does.
    folder("Deep")?.click();
    flushSync();
    expect(shimmers(folder("Deep"))).toBe(false);
    expect(page()?.classList.contains("presence")).toBe(true);
    expect(t.host.querySelectorAll(".tree-row.dir.presence")).toHaveLength(0);
    // Closed again while it lasts: back on the folder.
    folder("Guides")?.click();
    flushSync();
    expect(shimmers(folder("Guides"))).toBe(true);
    t.destroy();
  });
});
