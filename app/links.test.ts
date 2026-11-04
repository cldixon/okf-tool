import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { flushSync } from "svelte";
import { cache } from "./src/api";
import { LINK_REST_MS, linkLoad } from "./src/links";
import { fileKey } from "./src/page/data";
import { Urls } from "./src/urls";
import { rootPrefetchLinks } from "./test/runes.svelte.ts";

/*
 * Loading a page ahead from any link pointed at (TEMPRA-193, links.ts and links.svelte.ts): which
 * links are worth it, and the listener's rest, sweep and touch. The gate checks one in Chromium.
 */

const urls = new Urls("ann", "notes");
const lib = { owner: "ann", slug: "notes" };
let n = 0;
/** A page no other test has used, so the page cache starts empty for it. */
const freshPath = () => `notes/link-${++n}.md`;

function link(href: string, attrs: Record<string, string> = {}): HTMLAnchorElement {
  const a = document.createElement("a");
  a.href = href;
  for (const [k, v] of Object.entries(attrs)) a.setAttribute(k, v);
  a.textContent = "link";
  document.body.append(a);
  return a;
}

let asked: string[] = [];
const realFetch = globalThis.fetch;
beforeEach(() => {
  asked = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    asked.push(new URL(String(input), location.origin).pathname);
    return new Response("{}", { headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  document.body.replaceChildren();
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const pages = () => asked.filter((p) => p.includes("/page/"));

describe("linkLoad", () => {
  test("a page of the library that registered a load", () => {
    const path = freshPath();
    expect(linkLoad(link(urls.file(path)), lib)?.key).toBe(fileKey(urls, path));
    // On an account page (the Inbox) any library's pages.
    expect(linkLoad(link(`/bob/other/${freshPath()}`), null)).not.toBeNull();
  });

  test("never elsewhere, a download, another library, a cached or unregistered page", () => {
    expect(linkLoad(link(urls.file(freshPath()), { target: "_blank" }), lib)).toBeNull();
    expect(linkLoad(link(urls.file(freshPath()), { download: "" }), lib)).toBeNull();
    expect(linkLoad(link(`https://example.com/ann/notes/${freshPath()}`), lib)).toBeNull();
    expect(linkLoad(link(`/bob/other/${freshPath()}`), lib)).toBeNull();
    expect(linkLoad(link("/ann/notes/-/members"), lib)).toBeNull();
    expect(linkLoad(link("/inbox"), lib)).toBeNull();
    const path = freshPath();
    cache.put(fileKey(urls, path), {}, performance.now());
    expect(linkLoad(link(urls.file(path)), lib)).toBeNull();
  });
});

describe("usePrefetchLinks", () => {
  test("a link the pointer rests on loads its page; a sweep loads only where it rests", async () => {
    const stop = rootPrefetchLinks(lib);
    flushSync();
    const [a, b, c] = [freshPath(), freshPath(), freshPath()];
    const links = [link(urls.file(a)), link(urls.file(b)), link(urls.file(c))];
    for (const l of links) l.dispatchEvent(new PointerEvent("pointerover", { bubbles: true }));
    await sleep(LINK_REST_MS + 40);
    expect(pages()).toEqual([`/api/v1/libraries/ann/notes/page/${c}`]);
    // Left before the rest is up: nothing.
    const d = link(urls.file(freshPath()));
    d.dispatchEvent(new PointerEvent("pointerover", { bubbles: true }));
    d.dispatchEvent(new PointerEvent("pointerout", { bubbles: true }));
    await sleep(LINK_REST_MS + 40);
    expect(pages()).toHaveLength(1);
    stop();
  });

  test("a touch loads at once", () => {
    const stop = rootPrefetchLinks(lib);
    flushSync();
    const path = freshPath();
    link(urls.file(path)).dispatchEvent(new Event("touchstart", { bubbles: true }));
    expect(pages()).toEqual([`/api/v1/libraries/ann/notes/page/${path}`]);
    stop();
  });

  test("gone with the frame", async () => {
    const stop = rootPrefetchLinks(lib);
    flushSync();
    stop();
    link(urls.file(freshPath())).dispatchEvent(new Event("touchstart", { bubbles: true }));
    expect(pages()).toHaveLength(0);
  });
});
