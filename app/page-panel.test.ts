/**
 * The page panel (tempra-dev app/page-panel), drawn with a fake host: one page as the reader draws
 * it, read only, with its head, byline and sources; web links opened through the host, links to
 * the library's other files left as text.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { parseMarkdown } from "@tempra/editor";
import { flushSync } from "svelte";
import PagePanel from "./src/panels/PagePanel.svelte";
import { bylineName, type PageHost, type PagePayload, pageFrom, whereOf } from "./src/panels/page";
import { draw, settle } from "./test/dom";

function payload(over: Partial<PagePayload> = {}): PagePayload {
  return {
    v: 1,
    library: { owner: "ann", slug: "notes" },
    page: {
      path: "metrics/margin.md",
      seq: 4,
      title: "Margin",
      description: "Gross margin.",
      status: "draft",
      stale: false,
      doc: parseMarkdown(
        "# Margin\n\nMargin is revenue minus cost.[^book] See [costs](/metrics/costs.md) and [the web](https://example.com).\n",
      ),
      images: {},
    },
    sources: [{ id: "book", title: "The book", resource: "https://example.com/book" }],
    byline: { name: "claude-code for @ann", agent: true, at: "2026-10-28T01:00:00Z" },
    ...over,
  };
}

function fakeHost() {
  const links: string[] = [];
  let on: ((p: PagePayload | null) => void) | null = null;
  const host: PageHost = {
    subscribe(l) {
      on = l;
      return () => {
        on = null;
      };
    },
    openLink: async (url) => {
      links.push(url);
      return true;
    },
  };
  const give = (p: PagePayload | null) => {
    on?.(p);
    flushSync();
  };
  return { host, give, links };
}

let cleanup: (() => void) | null = null;
afterEach(() => {
  cleanup?.();
  cleanup = null;
});

describe("the page panel", () => {
  test("pageFrom takes a show result's page and nothing else", () => {
    expect(pageFrom({ structuredContent: { page: payload() } })?.page.title).toBe("Margin");
    expect(pageFrom({ structuredContent: { upload: {} } })).toBeNull();
    expect(pageFrom({ structuredContent: { page: { v: 2 } } })).toBeNull();
    expect(pageFrom(null)).toBeNull();
  });

  test("names the byline as the app does, and says where the page sits", () => {
    expect(bylineName({ name: "claude-code for @ann", agent: true, at: "" })).toBe(
      "Claude Code for @ann",
    );
    expect(bylineName({ name: "claude-code", agent: true, at: "" })).toBe("Claude Code");
    expect(bylineName({ name: "ann", agent: false, at: "" })).toBe("ann");
    expect(whereOf(payload())).toBe("ann/notes / Metrics");
  });

  test("draws the page with the reader, its head and its sources", async () => {
    const h = fakeHost();
    const d = draw(PagePanel, { host: h.host });
    cleanup = d.destroy;
    expect(d.host.textContent).toContain("Opening the page");
    h.give(payload());
    await settle();
    const root = d.host;
    expect(root.querySelector(".pp-title")?.textContent).toBe("Margin");
    expect(root.querySelector(".pp-description")?.textContent).toBe("Gross margin.");
    expect(root.querySelector(".pp-byline")?.textContent).toContain(
      "Claude Code for @ann · edited",
    );
    expect(root.querySelector(".pp-byline .chip")?.textContent).toBe("Draft");
    // The body is the app's reader: textblocks at their offsets, the repeated title hidden.
    expect(root.querySelector(".doc .body > .prose [data-text]")).not.toBeNull();
    expect(root.querySelector(".prose h1:not([hidden])")).toBeNull();
    expect(root.querySelector(".prose")?.textContent).toContain("Margin is revenue minus cost.");
    expect(root.querySelector(".prose sup.fnref")?.textContent).toContain("1");
    expect(root.querySelector(".pp-sources li")?.textContent).toContain("The book");
    // Read only: no controls at all.
    expect(root.querySelectorAll("button, textarea, input")).toHaveLength(0);
  });

  test("a web link opens through the host; another library page is text", async () => {
    const h = fakeHost();
    const d = draw(PagePanel, { host: h.host });
    cleanup = d.destroy;
    h.give(payload());
    await settle();
    expect(d.host.querySelector('a[href*="costs"]')).toBeNull();
    expect(d.host.querySelector(".prose")?.textContent).toContain("See costs and");
    d.host.querySelector<HTMLAnchorElement>('.prose a[href="https://example.com"]')?.click();
    await settle();
    expect(h.links).toEqual(["https://example.com/"]);
  });

  test("a result it cannot draw says so", async () => {
    const h = fakeHost();
    const d = draw(PagePanel, { host: h.host });
    cleanup = d.destroy;
    h.give(null);
    await settle();
    expect(d.host.textContent).toContain("This page could not be shown.");
  });
});
