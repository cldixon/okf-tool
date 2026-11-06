import { describe, expect, test } from "bun:test";
import { flushSync } from "svelte";
import { actorView } from "./src/agents";
import type { FeedEvent } from "./src/live";
import { type HistoryEvent, type PageFile, standing } from "./src/page/data";
import type { Live } from "./src/page/live";
import PageInfo from "./src/page/PageInfo.svelte";
import { Urls } from "./src/urls";
import { draw } from "./test/dom";

// Page info (TEMPRA-283; tempra-dev: decisions/page-tools-in-the-corner): what History and
// Properties held, in one card: the newer version and the check on top, then About this page and
// Versions.

const page = {
  kind: "page",
  path: "a.md",
  seq: 30,
  hash: "h",
  frontmatter: { title: "A", type: "Policy", status: "stable" },
  lint: [],
  trust_tier: "unverified",
  stale: false,
  doc: { type: "root", children: [] },
} as unknown as PageFile;

const ev = (seq: number, op: string, actor: string, note: string | null = null): HistoryEvent =>
  ({
    seq,
    ts: "2026-10-12T10:00:00Z",
    actor,
    op,
    path: "a.md",
    hash: `h${seq}`,
    meta: note ? { note } : null,
  }) as unknown as HistoryEvent;

const written = [
  ev(10, "put", "claude-ai/connector", "Created"),
  ev(20, "put", "claude-ai/connector", "Six weeks"),
];
const checkedThen = [...written, ev(25, "verify", "human:ann")];
const changedSince = [...checkedThen, ev(30, "put", "claude-ai/connector", "Edits only")];

function info(events: HistoryEvent[], over: Record<string, unknown> = {}) {
  const seq = Math.max(...events.map((e) => e.seq));
  return draw(PageInfo, {
    urls: new Urls("ann", "notes"),
    page: { ...page, seq } as PageFile,
    links: { inbound: [], broken: [] },
    head: seq,
    standing: standing(events, seq),
    reads: null,
    name: (actor: string) => actorView(actor, null, {}, null),
    current: true,
    reviewing: false,
    comparing: false,
    mayVerify: true,
    live: null,
    onVerified() {},
    ...over,
  });
}

const now = (host: Element) =>
  [...host.querySelectorAll(".page-info-now > li")].map((li) =>
    li.textContent?.replace(/\s+/g, " ").trim(),
  );

describe("Page info", () => {
  test("its sections: About this page, then Current version", () => {
    const d = info(changedSince);
    const heads = [...d.host.querySelectorAll(".page-info-section > h3")].map((h) => h.textContent);
    expect(heads).toEqual(["About this page", "Current version"]);
    // The facts are Properties' (Status), and the check is no longer among them.
    expect(d.host.querySelector(".facts")?.textContent).toContain("Status");
    expect(d.host.querySelector(".panel-section.check")).toBeNull();
    d.destroy();
  });

  test("collapsed: the current version alone, then Earlier versions (n), closed", () => {
    const d = info(changedSince);
    const notes = () => [...d.host.querySelectorAll(".version-note")].map((n) => n.textContent);
    expect(notes()).toEqual(["Edits only"]);
    const latest = d.host.querySelector<HTMLAnchorElement>(".latest-version a.version");
    expect(latest?.querySelector(".version-n")?.textContent).toBe("v3");
    // One click from what it changed (the latest with ?since= the one before).
    expect(latest?.getAttribute("href")).toContain("since=20");
    expect(latest?.getAttribute("aria-current")).toBe("true");
    const toggle = d.host.querySelector<HTMLButtonElement>("button.disclosure");
    expect(toggle?.textContent).toBe("Earlier versions 2");
    expect(toggle?.getAttribute("aria-expanded")).toBe("false");
    expect(d.host.querySelector("#page-info-earlier")).toBeNull();
    d.destroy();
  });

  test("expanded: the rest newest first, and closing again", () => {
    const d = info(changedSince);
    const toggle = d.host.querySelector<HTMLButtonElement>("button.disclosure");
    toggle?.click();
    flushSync();
    expect(toggle?.getAttribute("aria-expanded")).toBe("true");
    expect(toggle?.getAttribute("aria-controls")).toBe("page-info-earlier");
    const earlier = d.host.querySelector("#page-info-earlier");
    expect(
      [...(earlier?.querySelectorAll(".version-note") ?? [])].map((n) => n.textContent),
    ).toEqual(["Six weeks", "Created"]);
    toggle?.click();
    flushSync();
    expect(d.host.querySelector("#page-info-earlier")).toBeNull();
    d.destroy();
  });

  test("a single version: that row alone, no disclosure", () => {
    const d = info([ev(10, "put", "claude-ai/connector", "Created")]);
    expect([...d.host.querySelectorAll(".version-n")].map((n) => n.textContent)).toEqual(["v1"]);
    expect(d.host.querySelector("button.disclosure")).toBeNull();
    d.destroy();
  });

  test("many versions: ten earlier at a time, then n older versions", () => {
    const many = Array.from({ length: 25 }, (_, i) =>
      ev(10 * (i + 1), "put", "claude-ai/connector", `Edit ${i + 1}`),
    );
    const d = info(many);
    expect(d.host.querySelector("button.disclosure")?.textContent).toBe("Earlier versions 24");
    d.host.querySelector<HTMLButtonElement>("button.disclosure")?.click();
    flushSync();
    const rows = () => d.host.querySelectorAll("#page-info-earlier .version-n");
    expect(rows().length).toBe(10);
    expect(rows()[0]?.textContent).toBe("v24");
    const more = () => d.host.querySelector<HTMLButtonElement>(".older-versions");
    expect(more()?.textContent).toBe("14 older versions");
    more()?.click();
    flushSync();
    expect(rows().length).toBe(20);
    more()?.click();
    flushSync();
    expect(rows().length).toBe(24);
    expect(more()).toBeNull();
    d.destroy();
  });

  test("an earlier version on screen: the list starts open with it marked", () => {
    const events = changedSince;
    const d = draw(PageInfo, {
      urls: new Urls("ann", "notes"),
      page: { ...page, seq: 20 } as PageFile,
      links: { inbound: [], broken: [] },
      head: 30,
      standing: standing(events, 20),
      reads: null,
      name: (actor: string) => actorView(actor, null, {}, null),
      current: false,
      reviewing: false,
      comparing: true,
      mayVerify: true,
      live: null,
      onVerified() {},
    });
    expect(d.host.querySelector("button.disclosure")?.getAttribute("aria-expanded")).toBe("true");
    const marked = d.host.querySelector('#page-info-earlier a.version[aria-current="true"]');
    expect(marked?.querySelector(".version-n")?.textContent).toBe("v2");
    expect(marked?.classList.contains("chosen")).toBe(true);
    d.destroy();
  });

  test("changed since someone checked: how much, and Show changes into review mode", () => {
    const d = info(changedSince);
    expect(now(d.host)).toEqual(["1 change since ann checkedShow changes"]);
    const show = d.host.querySelector<HTMLAnchorElement>(".page-info-check a");
    expect(show?.getAttribute("href")).toContain("review=1");
    d.destroy();
    // While reviewing, the review bar is the way out: no second Show changes.
    const reviewing = info(changedSince, { reviewing: true });
    expect(reviewing.host.querySelector(".page-info-check a")).toBeNull();
    reviewing.destroy();
  });

  test("checked and unchanged: a quiet line; nobody checked: Mark as checked for a write member", () => {
    const quiet = info(checkedThen);
    expect(now(quiet.host)).toEqual(["Checked by ann, Oct 12"]);
    quiet.destroy();
    const never = info(written);
    expect(now(never.host)).toEqual(["Nobody has checked this pageMark as checked"]);
    never.destroy();
    const reader = info(written, { mayVerify: false });
    // A reader has nothing to do here: no empty list above About this page.
    expect(reader.host.querySelector(".page-info-now")).toBeNull();
    reader.destroy();
    // An earlier version on screen: no check at all (it is of the latest only).
    const old = info(changedSince, { current: false });
    expect(old.host.querySelector(".page-info-now")).toBeNull();
    old.destroy();
  });

  test("a newer version: the line on top, and Show it swaps it in", () => {
    let swapped = 0;
    const change = {
      seq: 40,
      ts: "2026-11-04T10:00:00Z",
      actor: "claude-ai/connector",
      op: "write",
      path: "a.md",
      note: "More weeks",
      by: null,
    } as unknown as FeedEvent;
    const live: Live = { change, shownSeq: 30, onSwap: () => swapped++ };
    const d = info(checkedThen, { live });
    const first = d.host.querySelector(".page-info-now > li.page-info-newer");
    expect(first?.textContent).toContain("A newer version");
    expect(first?.querySelector(".agent-dot")).not.toBeNull();
    first?.querySelector<HTMLButtonElement>("button")?.click();
    expect(swapped).toBe(1);
    d.destroy();
  });
});
