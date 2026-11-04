import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cache } from "./src/api";
import { HOLD_MS, holdFor } from "./src/hold";
import { follow, here } from "./src/location.svelte.ts";
import { fileKey } from "./src/page/data";
import { homeKey } from "./src/pages/home";
import { Urls } from "./src/urls";

/*
 * Keeping the page on screen while the next one loads (TEMPRA-194, hold.ts): which moves wait, and
 * how the address and the page's URL part and meet again. The gate checks it in Chromium.
 */

const base = "http://localhost";
const at = (path: string) => new URL(path, base);
const urls = new Urls("ann", "notes");
let n = 0;
/** A page no other test has opened, so the page cache starts empty for it. */
const freshPath = () => `notes/page-${++n}.md`;

/** The API as a test controls it: every answer waits until `release()`. */
let release: () => void = () => {};
let asked: string[] = [];
const realFetch = globalThis.fetch;
beforeEach(() => {
  asked = [];
  let open: () => void = () => {};
  const gate = new Promise<void>((r) => {
    open = r;
  });
  release = open;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input), base);
    asked.push(url.pathname);
    await gate;
    // The file's page in one call (TEMPRA-191): a page with its context.
    const path = decodeURIComponent(url.pathname.split("/page/")[1] ?? "");
    const body = url.pathname.includes("/page/")
      ? {
          file: { kind: "page", path, seq: 7, hash: "h", doc: { type: "root", children: [] } },
          head: 7,
          sources: { sources: [], unmatched_footnotes: [] },
          links: { inbound: [], broken: [] },
          history: { events: [] },
        }
      : {};
    return new Response(JSON.stringify(body), {
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  // Start every test on the library's settings, which waits for nothing.
  follow(at("/ann/notes/-/settings"));
});
afterEach(() => {
  release();
  globalThis.fetch = realFetch;
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("holdFor", () => {
  const shown = at("/ann/notes/a.md");
  test("another page of the library waits for its load", () => {
    const path = freshPath();
    expect(holdFor(shown, at(`/ann/notes/${path}`))?.key).toBe(fileKey(urls, path));
    expect(holdFor(shown, at("/ann/notes/"))?.key).toBe(homeKey(urls));
  });
  test("a page seen before, the same page, another library or an unregistered page does not", () => {
    const path = freshPath();
    cache.put(fileKey(urls, path), {}, performance.now());
    expect(holdFor(shown, at(`/ann/notes/${path}`))).toBeNull();
    expect(holdFor(shown, at("/ann/notes/a.md?panel=history"))).toBeNull();
    expect(holdFor(shown, at(`/bob/notes/${freshPath()}`))).toBeNull();
    expect(holdFor(shown, at("/ann/notes/-/members"))).toBeNull();
    expect(holdFor(at("/inbox"), at(`/ann/notes/${freshPath()}`))).toBeNull();
  });
});

describe("follow", () => {
  test("the address moves at once; the page follows when its data is in", async () => {
    const path = freshPath();
    follow(at(`/ann/notes/${path}`));
    expect(here.address.pathname).toBe(`/ann/notes/${path}`);
    expect(here.url.pathname).toBe("/ann/notes/-/settings");
    expect(here.held).toBe(true);
    release();
    await sleep(10);
    expect(here.url.pathname).toBe(`/ann/notes/${path}`);
    expect(here.held).toBe(false);
    expect(here.loading).toBe(false);
    // Kept as a fresh answer: the page draws from it without asking again.
    expect(cache.fresh(fileKey(urls, path))).toBe(true);
    expect(asked.filter((p) => p.includes("/page/"))).toHaveLength(1);
  });

  test("a slow page replaces the old one after the hold, and says it is loading", async () => {
    const path = freshPath();
    follow(at(`/ann/notes/${path}`));
    await sleep(HOLD_MS + 50);
    expect(here.url.pathname).toBe(`/ann/notes/${path}`);
    expect(here.held).toBe(false);
    expect(here.loading).toBe(true);
    release();
    await sleep(10);
    expect(here.loading).toBe(false);
  });

  test("a later move wins over a held one", async () => {
    const slow = freshPath();
    follow(at(`/ann/notes/${slow}`));
    follow(at("/ann/notes/-/members"));
    expect(here.url.pathname).toBe("/ann/notes/-/members");
    expect(here.held).toBe(false);
    release();
    await sleep(HOLD_MS + 50);
    expect(here.url.pathname).toBe("/ann/notes/-/members");
    expect(here.address.pathname).toBe("/ann/notes/-/members");
  });

  test("asking again for a held move changes nothing (a redirect's effect)", () => {
    const path = freshPath();
    follow(at(`/ann/notes/${path}`));
    const address = here.address;
    follow(at(`/ann/notes/${path}`));
    expect(here.address).toBe(address);
    expect(here.held).toBe(true);
    expect(asked.filter((p) => p.includes("/page/"))).toHaveLength(1);
  });

  test("a page that registered no load follows at once", () => {
    follow(at("/ann/notes/-/settings?x=1"));
    expect(here.url.search).toBe("?x=1");
    expect(here.held).toBe(false);
  });
});
