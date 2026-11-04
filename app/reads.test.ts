import { describe, expect, test } from "bun:test";
import { actorView } from "./src/agents";
import type { PageFile, Standing } from "./src/page/data";
import PropertiesList from "./src/page/PropertiesList.svelte";
import { type ReadHistory, readWords } from "./src/page/reads";
import { Urls } from "./src/urls";
import { draw } from "./test/dom";

// Read history in Properties (TEMPRA-220, tempra-dev: v2/read-history): how much the page is
// read and how recently, in people's words; counts only, never who.

const counts = (total: number, agents: number) => ({
  total,
  agents,
  people: total - agents,
  mcp: agents,
  app: total - agents,
  api: 0,
  readers: 2,
});
const history = (week: number, agents: number, month: number, last: string | null) =>
  ({
    week: counts(week, agents),
    month: counts(month, agents),
    last: { mcp: last, app: null, api: null },
    last_read: last,
  }) satisfies ReadHistory;

describe("read history in people's words", () => {
  test("this week, by agents, this month, never", () => {
    expect(readWords(history(14, 9, 40, null))).toBe("14 times this week, 9 by agents");
    expect(readWords(history(1, 0, 1, null))).toBe("1 time this week");
    expect(readWords(history(3, 3, 3, null))).toBe("3 times this week, all by agents");
    expect(readWords(history(0, 0, 5, null))).toBe("Not this week, 5 times this month");
    expect(readWords(history(0, 0, 0, null))).toBe("Not in the last month");
  });

  test("Properties shows Read and Last read, and nothing of who", () => {
    const page = {
      kind: "page",
      path: "a.md",
      seq: 2,
      hash: "h",
      frontmatter: { title: "A", type: "Policy" },
      lint: [],
      trust_tier: "unverified",
      stale: false,
      doc: { type: "root", children: [] },
    } as unknown as PageFile;
    const standing: Standing = { versions: [], current: null, verified: null, since: 0 };
    const twoHours = new Date(Date.now() - 2 * 3_600_000 - 60_000).toISOString();
    const props = {
      urls: new Urls("ann", "notes"),
      page,
      links: { inbound: [], broken: [] },
      head: 2,
      standing,
      name: (actor: string) => actorView(actor, null, {}, null),
      current: true,
      reviewing: false,
      mayVerify: false,
      onVerified() {},
    };
    const p = draw(PropertiesList, { ...props, reads: history(14, 9, 40, twoHours) });
    const facts = [...p.host.querySelectorAll(".fact")].map((f) => [
      f.querySelector("dt")?.textContent,
      f.querySelector("dd")?.textContent,
    ]);
    expect(facts).toContainEqual(["Read", "14 times this week, 9 by agents"]);
    const last = facts.find(([dt]) => dt === "Last read")?.[1] ?? "";
    // "2 hours ago", or "yesterday" when that crossed midnight here.
    expect(["2 hours ago", "yesterday"]).toContain(last);
    expect(p.host.querySelector(".fact time")?.getAttribute("datetime")).toBe(twoHours);
    expect(p.host.textContent).not.toMatch(/mcp|claude|reader/i);
    p.destroy();

    const never = draw(PropertiesList, { ...props, reads: history(0, 0, 0, null) });
    const text = never.host.textContent ?? "";
    expect(text).toContain("Not in the last month");
    expect(text).toContain("not yet");
    never.destroy();

    // Unknown (an older answer): no rows.
    const none = draw(PropertiesList, { ...props, reads: null });
    expect(none.host.textContent).not.toContain("Last read");
    none.destroy();
  });
});
