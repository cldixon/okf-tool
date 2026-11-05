/**
 * Comments after the first @tempra demo (TEMPRA-223): every comment author's round mark, Tempra's
 * own filled with the agent colour, and the page's corner tools (TEMPRA-283): Comments with its
 * open count, Page info with the newer-version dot, Copy page with its ⌄.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { flushSync } from "svelte";
import Avatar from "./src/Avatar.svelte";
import { actorView, agentInitial, TEMPRA_ACTOR } from "./src/agents";
import PageTools from "./src/page/PageTools.svelte";
import type { PanelName } from "./src/page/panel";
import { Urls } from "./src/urls";
import { draw } from "./test/dom";

// happy-dom lays nothing out; the menu takes the choices it can see (as chrome.test.ts does).
const rects = Element.prototype.getClientRects;
beforeAll(() => {
  Element.prototype.getClientRects = () => [{}] as unknown as DOMRectList;
});
afterAll(() => {
  Element.prototype.getClientRects = rects;
});

const agents = {
  agt_claude: {
    person: "dev",
    agent: { id: "agt_claude", name: "claude-ai", platform: "claude.ai", client: null },
    actor: "claude-ai/connector",
    requests: 3,
    last_ts: "2026-10-30T10:00:00Z",
  },
  agt_tempra: {
    person: "dev",
    agent: { id: "agt_tempra", name: "Tempra", platform: "tempra", client: null },
    actor: TEMPRA_ACTOR,
    requests: 1,
    last_ts: "2026-10-30T10:00:00Z",
  },
};

describe("a comment author's round mark", () => {
  test("an agent's one letter is the first of its name as the app names it", () => {
    const claude = actorView(
      "claude-ai/connector",
      { person: "u1", agent: "agt_claude" },
      agents,
      null,
    );
    const tempra = actorView(TEMPRA_ACTOR, { person: "u1", agent: "agt_tempra" }, agents, null);
    expect(claude.name).toBe("Claude");
    expect(agentInitial(claude.mark)).toBe("C");
    expect(claude.tempra).toBe(false);
    expect(tempra.name).toBe("Tempra");
    expect(agentInitial(tempra.mark)).toBe("T");
    expect(tempra.tempra).toBe(true);
    // Unknown to the list: still named from its actor, never its raw id.
    expect(agentInitial(actorView("claude-code/local", null, {}, null).mark)).toBe("C");
    expect(actorView("human:ann", null, agents, null).tempra).toBe(false);
    expect(agentInitial("  (beta) agent")).toBe("B");
    expect(agentInitial("")).toBe("?");
  });

  test("drawn decorative: a person's initials, an agent on ink, Tempra's own on the agent colour", () => {
    const mark = (props: {
      name: string;
      fullName?: string | null;
      agent?: boolean;
      tempra?: boolean;
    }) => {
      const d = draw(Avatar, props);
      const el = d.host.querySelector(".avatar-mark") as HTMLElement;
      const out = {
        cls: el.className,
        text: el.textContent,
        hidden: el.getAttribute("aria-hidden"),
      };
      d.destroy();
      return out;
    };
    expect(mark({ name: "ann_lee" })).toEqual({ cls: "avatar-mark", text: "AL", hidden: "true" });
    // From the account's name when given (TEMPRA-54).
    expect(mark({ name: "ann_lee", fullName: "Ann Smith" }).text).toBe("AS");
    expect(mark({ name: "sam", fullName: "Sam" }).text).toBe("S");
    expect(mark({ name: "Claude", agent: true })).toEqual({
      cls: "avatar-mark agent",
      text: "C",
      hidden: "true",
    });
    expect(mark({ name: "Tempra", agent: true, tempra: true })).toEqual({
      cls: "avatar-mark agent tempra",
      text: "T",
      hidden: "true",
    });
  });
});

describe("the page's corner tools (TEMPRA-283)", () => {
  function row(
    props: {
      openCount?: number;
      panel?: PanelName | null;
      newer?: boolean;
      markdown?: boolean;
    } = {},
  ) {
    const opened: PanelName[] = [];
    const markdown: boolean[] = [];
    const d = draw(PageTools, {
      urls: new Urls("ann", "notes"),
      path: "a/page.md",
      openCount: props.openCount ?? 0,
      panel: props.panel ?? null,
      newer: props.newer ?? false,
      markdown: props.markdown ?? false,
      onPanel: (p: PanelName) => opened.push(p),
      onMarkdown: (on: boolean) => markdown.push(on),
      place: "side",
    });
    const button = (name: string) =>
      d.host.querySelector<HTMLButtonElement>(`button[aria-label="${name}"]`);
    return { d, opened, markdown, button };
  }

  test("Comments with its open count beside it, opening the Comments panel", () => {
    const r = row({ openCount: 2 });
    const c = r.button("Comments, 2 open");
    expect(c).not.toBeNull();
    expect(c?.className).toContain("icon-button outlined has-count");
    expect(c?.querySelector(".icon-button-count")?.textContent).toBe("2");
    expect(c?.getAttribute("title")).toBe("Comments");
    expect(c?.getAttribute("aria-pressed")).toBe("false");
    c?.click();
    flushSync();
    expect(r.opened).toEqual(["comments"]);
    r.d.destroy();
  });

  test("no open threads: Comments alone, no count", () => {
    const r = row();
    const c = r.button("Comments");
    expect(c?.querySelector(".icon-button-count")).toBeNull();
    expect(c?.className).not.toContain("has-count");
    r.d.destroy();
  });

  test("the open panel's button shows pressed", () => {
    const r = row({ panel: "info" });
    expect(r.button("Page info")?.getAttribute("aria-pressed")).toBe("true");
    expect(r.button("Comments")?.getAttribute("aria-pressed")).toBe("false");
    r.button("Page info")?.click();
    flushSync();
    expect(r.opened).toEqual(["info"]);
    r.d.destroy();
  });

  test("a newer version puts the agent dot on Page info", () => {
    const quiet = row();
    expect(quiet.button("Page info")?.querySelector(".icon-button-dot")).toBeNull();
    quiet.d.destroy();
    const r = row({ newer: true });
    const info = r.button("Page info, a newer version");
    expect(info?.querySelector(".icon-button-dot")).not.toBeNull();
    r.d.destroy();
  });

  test("Copy page, and its ⌄ with View Markdown and Download .md (no Copy link)", () => {
    const r = row();
    expect(r.button("Copy page")?.className).toBe("split-main");
    const more = r.button("More copy options");
    expect(more?.getAttribute("aria-expanded")).toBe("false");
    more?.click();
    flushSync();
    const items = Array.from(r.d.host.querySelectorAll<HTMLElement>(".menu-list .menu-item")).map(
      (i) => i.textContent?.replace(/\s+/g, " ").trim(),
    );
    expect(items).toEqual(["View Markdown", "Download .md"]);
    const view = r.d.host.querySelector<HTMLButtonElement>(".menu-list button.menu-item");
    view?.click();
    flushSync();
    expect(r.markdown).toEqual([true]);
    r.d.destroy();
  });
});
