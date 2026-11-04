import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createRawSnippet, flushSync } from "svelte";
import AccountFrame from "./src/AccountFrame.svelte";
import Tree from "./src/Tree.svelte";
import { buildDirs, type OutlineFile, rollUp } from "./src/tree";
import { Urls } from "./src/urls";
import { draw, settle } from "./test/dom";

/** The DOM's text without Svelte's comment anchors. */
const html = (el: Element) => el.innerHTML.replace(/<!---->/g, "");

const OUTLINE: OutlineFile[] = [
  { path: "b/z.md", kind: "page", title: "Zebra", seq: 3 },
  { path: "b/a.md", kind: "page", title: "Apple", seq: 4, comments: 2 },
  { path: "b/pic.png", kind: "attachment", seq: 5 },
  { path: "b/c/deep.md", kind: "page", title: "Deep", seq: 6, stale: "stale" },
  { path: "a/one.md", kind: "page", title: "One", seq: 7 },
  { path: "top.md", kind: "page", title: "Top", seq: 8, stale: "stale_soon" },
];

class NoSocket {
  static OPEN = 1;
  readyState = 0;
  addEventListener() {}
  removeEventListener() {}
  close() {}
  send() {}
}

// Svelte asks whether an element is media when it sets some attributes; the shared DOM lacks it.
const g = globalThis as Record<string, unknown>;
g.HTMLMediaElement ??= (window as unknown as Record<string, unknown>).HTMLMediaElement;

/** One reply waiting in the Inbox, as the bell's panel lists it. */
const INBOX_ITEM = {
  id: "i1",
  kind: "reply",
  library: "ann/notes",
  library_title: "Notes",
  path: "a.md",
  thread: "t1",
  title: "Reader",
  actor: "human:ann",
  who: "@ann",
  agent: false,
  excerpt: "Done.",
  invitation: null,
  created: new Date().toISOString(),
  done_at: null,
  actions: ["reply", "resolve"],
  href: "/ann/notes/a.md#comments",
};

const INVITE_ITEM = {
  ...INBOX_ITEM,
  id: "i2",
  kind: "invitation",
  library: "sam/plans",
  library_title: "Plans",
  path: null,
  thread: null,
  title: null,
  actor: "human:sam",
  who: "@sam",
  excerpt: "write",
  invitation: "inv1",
  actions: ["accept", "decline"],
  href: "/invitations",
};

/** A monthly quota's notice (TEMPRA-232): on the account, opening its usage. */
const QUOTA_ITEM = {
  ...INBOX_ITEM,
  id: "i3",
  kind: "quota",
  library: "",
  library_title: null,
  path: null,
  thread: null,
  title: "Writes this month",
  actor: "tempra",
  who: "tempra",
  excerpt: "80% used: 80,000 of 100,000",
  actions: ["open"],
  href: "/account#usage",
};

const realFetch = globalThis.fetch;
const realSocket = globalThis.WebSocket;
beforeEach(() => {
  document.body.innerHTML = "";
  localStorage.clear();
  globalThis.WebSocket = NoSocket as unknown as typeof WebSocket;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    const body = url.includes("/outline")
      ? { seq: 8, files: OUTLINE }
      : url.includes("/events")
        ? { events: [], seq: 8 }
        : url.includes("/inbox/count")
          ? { open: 4 }
          : url.includes("/api/v1/inbox?")
            ? { items: [INBOX_ITEM, INVITE_ITEM, QUOTA_ITEM], next: null, open: 4 }
            : url.includes("/api/v1/libraries")
              ? {
                  libraries: [
                    { owner: "dev", slug: "dev", title: "Dev" },
                    { owner: "ann", slug: "notes", title: "Notes", role: "read" },
                  ],
                }
              : {};
    return new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  globalThis.WebSocket = realSocket;
});

describe("the tree's rules (Tree.svelte, tree.ts)", () => {
  test("folders, then pages, then files, each by the name shown", () => {
    const dirs = buildDirs(OUTLINE);
    expect((dirs[""] ?? []).map((e) => e.path)).toEqual(["a", "b", "top.md"]);
    expect((dirs.b ?? []).map((e) => e.path)).toEqual(["b/c", "b/a.md", "b/z.md", "b/pic.png"]);
    expect(rollUp(OUTLINE.filter((f) => f.path.startsWith("b/")))).toEqual({
      comments: 2,
      stale: "stale",
    });
  });

  test("every folder starts open; a closed one rolls up its marks and is remembered", async () => {
    const urls = new Urls("dev", "dev");
    const t = draw(Tree, {
      urls,
      file: "b/a.md",
      dir: null,
      files: OUTLINE,
      failed: false,
      onRetry: () => {},
    });
    await settle(10);
    const rows = [...t.host.querySelectorAll(".tree-row")].map((r) => r.textContent);
    expect(rows).toEqual([
      "A",
      "One",
      "B",
      "C",
      "Deepstale",
      "Apple22 open comments",
      "Zebra",
      "pic.png",
      "Topstale soon",
    ]);
    expect(t.host.querySelector('a[aria-current="page"]')?.getAttribute("data-path")).toBe(
      "b/a.md",
    );
    expect(html(t.host)).toContain('<div class="tree-row file"><span class="tree-leaf"><svg');
    expect(html(t.host)).not.toMatch(/> </);
    const b = t.host.querySelector<HTMLButtonElement>('button.tree-name[title="B"]');
    expect(b?.getAttribute("aria-expanded")).toBe("true");
    b?.click();
    flushSync();
    expect(b?.getAttribute("aria-expanded")).toBe("false");
    expect(b?.closest(".tree-row")?.textContent).toBe("B22 open commentsstale");
    expect(localStorage.getItem("tempra:tree-closed:dev/dev")).toBe('["b"]');
    t.destroy();
  });
});

describe("the account's frame (AccountFrame.svelte)", () => {
  test("the bar, the sidebar and the page", async () => {
    const children = createRawSnippet(() => ({ render: () => "<p>Page</p>" }));
    // The library list has no sidebar and no drawer: its page lists the libraries (TEMPRA-189).
    const f = draw(AccountFrame, { page: "libraries", me: null, children });
    await settle(10);
    const brand = f.host.querySelector(".topbar-brand");
    expect(brand?.textContent).toBe("Tempra");
    expect(brand?.querySelector("a.brand-mark svg.mark")).not.toBeNull();
    expect(brand?.querySelector("button.search-button")?.getAttribute("aria-label")).toBe("Search");
    expect(f.host.querySelector("main.ws-main")?.textContent?.trim()).toBe("Page");
    expect(f.host.querySelector("section.ws-sidebar")).toBeNull();
    expect(f.host.querySelector("button.ws-menu")).toBeNull();
    expect(f.host.querySelector(".workspace.bare")).not.toBeNull();
    // The bell is the notifications: a panel of what waits, a reply a link to its thread, an
    // invitation answered in place; no Inbox page to link to.
    const bell = f.host.querySelector<HTMLButtonElement>("button.bell");
    expect(bell?.getAttribute("aria-label")).toBe("Notifications, 4 waiting");
    expect(bell?.querySelector(".badge")?.textContent).toBe("4");
    expect(f.host.querySelector(".bell-pop")).toBeNull();
    bell?.click();
    await settle(10);
    const pop = f.host.querySelector(".bell-pop");
    expect(pop?.querySelector(".bell-head")?.textContent).toBe("Notifications");
    const item = pop?.querySelector<HTMLAnchorElement>("a.bell-item");
    expect(item?.getAttribute("href")).toBe("/ann/notes/a.md#thread-t1");
    expect(item?.textContent).toContain("Reader");
    expect(item?.textContent).toContain("@ann replied to your thread");
    const invite = pop?.querySelector("div.bell-item");
    expect(invite?.textContent).toContain("Plans");
    expect(invite?.textContent).toContain("@sam invited you to write");
    const answers = [...(invite?.querySelectorAll("button") ?? [])].map((b) => b.textContent);
    expect(answers).toEqual(["Accept", "Decline"]);
    // A monthly quota (TEMPRA-232): on the account, opening its usage.
    const quota = pop?.querySelector<HTMLAnchorElement>('a.bell-item[href="/account#usage"]');
    expect(quota?.textContent).toContain("Writes this month");
    expect(quota?.textContent).toContain("80% used: 80,000 of 100,000");
    expect(quota?.textContent).toContain("Your account");
    expect(pop?.querySelector(".bell-more")?.textContent).toBe("1 more");
    expect(pop?.querySelector('a[href="/inbox"]')).toBeNull();
    f.destroy();
  });

  test("Invitations keep the account's sidebar", async () => {
    const children = createRawSnippet(() => ({ render: () => "<p>Page</p>" }));
    const f = draw(AccountFrame, { page: "invitations", me: null, children });
    await settle(10);
    const rows = [...f.host.querySelectorAll(".nav-row")].map((r) => r.textContent);
    expect(rows).toEqual(["Libraries", "DDev", "NNotes (@ann)"]);
    expect(f.host.querySelector("section.ws-sidebar")?.hasAttribute("hidden")).toBe(false);
    f.destroy();
  });
});
