/**
 * Comments after the first @tempra demo (TEMPRA-223): every comment author's round mark, Tempra's
 * own filled with the agent colour, and Comments in the page's ⋯ with its open count.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { flushSync } from "svelte";
import Avatar from "./src/Avatar.svelte";
import { actorView, agentInitial, TEMPRA_ACTOR } from "./src/agents";
import PageMenu from "./src/page/PageMenu.svelte";
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

describe("Comments in the page's ⋯", () => {
  function menu(openCount: number) {
    const opened: PanelName[] = [];
    const d = draw(PageMenu, {
      urls: new Urls("ann", "notes"),
      path: "a/page.md",
      openCount,
      panel: null,
      markdown: false,
      onPanel: (p: PanelName) => opened.push(p),
      onMarkdown: () => {},
    });
    const button = d.host.querySelector<HTMLButtonElement>("button[aria-expanded]");
    button?.click();
    flushSync();
    const items = Array.from(d.host.querySelectorAll<HTMLElement>(".menu-list .menu-item"));
    return {
      d,
      opened,
      items,
      texts: items.map((i) => i.textContent?.replace(/\s+/g, " ").trim()),
    };
  }

  test("with History and Properties, showing the open count, opening the Comments panel", () => {
    const m = menu(2);
    expect(m.texts.slice(0, 4)).toEqual(["Copy page", "Comments2 open", "History", "Properties"]);
    const comments = m.items[1] as HTMLElement;
    expect(comments.querySelector(".menu-count")?.textContent).toBe("2 open");
    comments.click();
    flushSync();
    expect(m.opened).toEqual(["comments"]);
    m.d.destroy();
  });

  test("no open threads: Comments alone, no count", () => {
    const m = menu(0);
    expect(m.texts[1]).toBe("Comments");
    m.d.destroy();
  });
});
