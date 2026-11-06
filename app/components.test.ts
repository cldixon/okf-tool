import { describe, expect, test } from "bun:test";
import {
  AvatarMark,
  Badge,
  Button,
  ChangeRow,
  Chip,
  CommentMark,
  Dialog,
  Disclosure,
  Field,
  Icon,
  IconButton,
  Mark,
  markSvg,
  Notice,
  PanelHead,
  PillButton,
  SearchButton,
  SearchField,
  Segmented,
  Select,
  SplitButton,
  TextInput,
  Tile,
  ToolPill,
} from "@tempra/design/components";
import { createRawSnippet, flushSync } from "svelte";
import Design from "./src/pages/Design.svelte";
import { match } from "./src/router";
import { draw, settle } from "./test/dom";

/*
 * @tempra/design/components (TEMPRA-252): each component draws the design CSS's classes, names
 * what it is for screen readers and takes its variants as props, as the shared spec has them.
 */

/** A snippet of plain text, for a component's children. */
const text = (s: string) => createRawSnippet(() => ({ render: () => `<span>${s}</span>` }));

/** The one element a component drew into its host. */
function one(host: HTMLElement, selector = "*"): HTMLElement {
  const el = host.querySelector<HTMLElement>(selector);
  if (!el) throw new Error(`nothing matches ${selector}`);
  return el;
}

describe("buttons", () => {
  test("Button: outlined by default, primary and ghost as classes, disabled, type", () => {
    let clicks = 0;
    const d = draw(Button, { children: text("Go"), onclick: () => clicks++ });
    const b = one(d.host, "button") as HTMLButtonElement;
    expect(b.className).toBe("");
    expect(b.type).toBe("button");
    expect(b.textContent).toBe("Go");
    b.click();
    expect(clicks).toBe(1);
    d.destroy();
    for (const variant of ["primary", "ghost"] as const) {
      const v = draw(Button, { variant, type: "submit", disabled: true, children: text("Save") });
      const vb = one(v.host, "button") as HTMLButtonElement;
      expect(vb.classList.contains(variant)).toBe(true);
      expect(vb.type).toBe("submit");
      expect(vb.disabled).toBe(true);
      v.destroy();
    }
  });

  test("Button passes other attributes on, a class beside its own", () => {
    const d = draw(Button, {
      variant: "primary",
      class: "fab",
      "aria-pressed": true,
      children: text("x"),
    });
    const b = one(d.host, "button");
    expect(b.className).toBe("primary fab");
    expect(b.getAttribute("aria-pressed")).toBe("true");
    d.destroy();
  });

  test("PillButton: a button, or a link with href, its glyph before its label", () => {
    const d = draw(PillButton, { icon: "previous", label: "Back to page" });
    const b = one(d.host, "button");
    expect(b.className).toBe("pill-button");
    expect(b.textContent).toBe("Back to page");
    expect(b.querySelector("svg")).not.toBeNull();
    d.destroy();
    const a = draw(PillButton, { label: "Download", href: "/x.md", download: "x.md" });
    const link = one(a.host, "a");
    expect(link.className).toBe("button pill-button");
    expect(link.getAttribute("href")).toBe("/x.md");
    expect(link.getAttribute("download")).toBe("x.md");
    expect(link.querySelector("svg")).toBeNull();
    a.destroy();
  });

  test("ToolPill: .tool-pill, a button or a link", () => {
    const d = draw(ToolPill, { label: "Tool" });
    expect(one(d.host, "button").className).toBe("tool-pill");
    d.destroy();
    const a = draw(ToolPill, { label: "Tool", href: "/t" });
    expect(one(a.host, "a").className).toBe("tool-pill");
    a.destroy();
  });

  test("IconButton outlined (TEMPRA-283): a ring, a count beside the glyph, the agent dot", () => {
    const d = draw(IconButton, {
      variant: "outlined",
      icon: "comments",
      label: "Comments, 2 open",
      count: 2,
    });
    const b = one(d.host, "button");
    expect(b.className).toBe("icon-button outlined has-count");
    expect(b.getAttribute("aria-label")).toBe("Comments, 2 open");
    expect(one(d.host, ".icon-button-count").textContent).toBe("2");
    expect(one(d.host, ".icon-button-count").getAttribute("aria-hidden")).toBe("true");
    d.destroy();
    const z = draw(IconButton, {
      variant: "outlined",
      icon: "comments",
      label: "Comments",
      count: 0,
    });
    expect(one(z.host, "button").className).toBe("icon-button outlined");
    expect(z.host.querySelector(".icon-button-count")).toBeNull();
    z.destroy();
    const p = draw(IconButton, {
      variant: "outlined",
      icon: "info",
      label: "Page info",
      dot: true,
      pressed: true,
    });
    const pb = one(p.host, "button");
    expect(pb.getAttribute("aria-pressed")).toBe("true");
    expect(one(p.host, ".icon-button-dot").getAttribute("aria-hidden")).toBe("true");
    p.destroy();
  });

  test("SplitButton (TEMPRA-283): a main action and a ⌄ menu, each named", () => {
    let copied = 0;
    const d = draw(SplitButton, {
      icon: "copy",
      label: "Copy page",
      menuLabel: "More copy options",
      onclick: () => copied++,
      children: createRawSnippet(() => ({
        render: () => '<a class="menu-item" href="#m">View Markdown</a>',
      })),
    });
    const wrap = one(d.host, ".split-button");
    const main = one(wrap, "button.split-main") as HTMLButtonElement;
    expect(main.getAttribute("aria-label")).toBe("Copy page");
    main.click();
    expect(copied).toBe(1);
    const more = one(wrap, "button.split-more") as HTMLButtonElement;
    expect(more.getAttribute("aria-label")).toBe("More copy options");
    expect(more.getAttribute("aria-expanded")).toBe("false");
    more.click();
    flushSync();
    expect(more.getAttribute("aria-expanded")).toBe("true");
    expect(one(wrap, ".menu-list.end .menu-item").textContent).toBe("View Markdown");
    d.destroy();
  });

  test("Disclosure (TEMPRA-309): a chevron, the label and its count; aria-expanded follows a press", () => {
    const told: boolean[] = [];
    const d = draw(Disclosure, {
      label: "Earlier versions",
      count: 7,
      controls: "earlier",
      class: "earlier-toggle",
      onchange: (open: boolean) => told.push(open),
    });
    const b = one(d.host, "button.disclosure") as HTMLButtonElement;
    expect(b.classList.contains("earlier-toggle")).toBe(true);
    expect(b.getAttribute("type")).toBe("button");
    expect(b.getAttribute("aria-expanded")).toBe("false");
    expect(b.getAttribute("aria-controls")).toBe("earlier");
    expect(b.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
    expect(one(b, ".disclosure-label").textContent).toBe("Earlier versions");
    expect(one(b, ".disclosure-count").textContent).toBe("7");
    b.click();
    flushSync();
    expect(b.getAttribute("aria-expanded")).toBe("true");
    b.click();
    flushSync();
    expect(b.getAttribute("aria-expanded")).toBe("false");
    expect(told).toEqual([true, false]);
    d.destroy();
    // No count at 0; open from the start when asked.
    const none = draw(Disclosure, { label: "More", count: 0, open: true });
    const n = one(none.host, "button.disclosure");
    expect(n.querySelector(".disclosure-count")).toBeNull();
    expect(n.getAttribute("aria-expanded")).toBe("true");
    none.destroy();
  });

  test("IconButton: named by its label, a toggle when pressed, a touch area", () => {
    const d = draw(IconButton, { icon: "more", label: "More" });
    const b = one(d.host, "button");
    expect(b.className).toBe("icon-button");
    expect(b.getAttribute("aria-label")).toBe("More");
    expect(b.getAttribute("title")).toBe("More");
    expect(b.hasAttribute("aria-pressed")).toBe(false);
    expect(b.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
    d.destroy();
    const p = draw(IconButton, {
      icon: "close",
      label: "Close comments",
      title: "Close",
      pressed: true,
      touch: true,
      class: "drawer-close",
    });
    const pb = one(p.host, "button");
    expect(pb.className).toBe("icon-button touch drawer-close");
    expect(pb.getAttribute("aria-pressed")).toBe("true");
    expect(pb.getAttribute("title")).toBe("Close");
    p.destroy();
  });

  test("SearchButton: Search, with its shortcut in the title", () => {
    const d = draw(SearchButton, { shortcut: "Ctrl K" });
    const b = one(d.host, "button");
    expect(b.className).toBe("icon-button search-button");
    expect(b.getAttribute("aria-label")).toBe("Search");
    expect(b.getAttribute("title")).toBe("Search (Ctrl K)");
    expect(b.getAttribute("aria-keyshortcuts")).toBe("Control+K Meta+K");
    d.destroy();
  });
});

describe("fields", () => {
  test("Field: the label around its control, the hint under it", () => {
    const d = draw(Field, { label: "Name", hint: "What people see", children: text("ctl") });
    const label = one(d.host, "label.field");
    expect(label.textContent).toBe("NamectlWhat people see");
    expect(one(label, ".field-hint").textContent).toBe("What people see");
    d.destroy();
    const n = draw(Field, { label: "Name", children: text("ctl") });
    expect(n.host.querySelector(".field-hint")).toBeNull();
    n.destroy();
  });

  test("TextInput: its value, placeholder, type, name and disabled", () => {
    const d = draw(TextInput, {
      value: "notes",
      placeholder: "Team notes",
      type: "email",
      name: "slug",
      disabled: true,
    });
    const i = one(d.host, "input") as HTMLInputElement;
    expect(i.value).toBe("notes");
    expect(i.placeholder).toBe("Team notes");
    expect(i.type).toBe("email");
    expect(i.name).toBe("slug");
    expect(i.disabled).toBe(true);
    d.destroy();
  });

  test("SearchField: a search input named by its label, the glyph inside .search-field", () => {
    const d = draw(SearchField, { label: "Search pages", placeholder: "Search…" });
    const box = one(d.host, ".search-field");
    const i = one(box, "input") as HTMLInputElement;
    expect(i.type).toBe("search");
    expect(i.getAttribute("aria-label")).toBe("Search pages");
    expect(i.placeholder).toBe("Search…");
    expect(box.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
    d.destroy();
  });

  test("Button with href: a link drawn as a button, its variant beside .button (TEMPRA-288)", () => {
    const d = draw(Button, {
      href: "/x.md",
      variant: "primary",
      download: "x.md",
      children: text("Download"),
    });
    const a = one(d.host, "a") as HTMLAnchorElement;
    expect(a.className).toBe("button primary");
    expect(a.getAttribute("href")).toBe("/x.md");
    expect(a.getAttribute("download")).toBe("x.md");
    expect(d.host.querySelector("button")).toBeNull();
    d.destroy();
    const plain = draw(Button, { href: "/y", children: text("Back") });
    expect(one(plain.host, "a").className).toBe("button");
    plain.destroy();
  });
});

describe("marks and labels", () => {
  test("Icon: one of Lucide's glyphs, decorative, at its size", () => {
    const d = draw(Icon, { name: "bell", size: 14 });
    const svg = one(d.host, "svg");
    expect(svg.getAttribute("aria-hidden")).toBe("true");
    expect(svg.getAttribute("width")).toBe("14");
    expect(svg.getAttribute("stroke-width")).toBe("1.5");
    d.destroy();
  });

  test("Chip: .chip, with warn and bad tones", () => {
    for (const [tone, cls] of [
      [undefined, "chip"],
      ["warn", "chip warn"],
      ["bad", "chip bad"],
    ] as const) {
      const d = draw(Chip, { tone, children: text("Draft") });
      const c = one(d.host, "span");
      expect(c.className).toBe(cls);
      expect(c.textContent).toBe("Draft");
      d.destroy();
    }
  });

  test("Notice: an error is an alert, ok a status", () => {
    const e = draw(Notice, { children: text("Failed") });
    expect(one(e.host, ".notice").getAttribute("role")).toBe("alert");
    expect(one(e.host, ".notice").className).toBe("notice");
    e.destroy();
    const o = draw(Notice, { tone: "ok", children: text("Saved") });
    expect(one(o.host, ".notice").className).toBe("notice ok");
    expect(one(o.host, ".notice").getAttribute("role")).toBe("status");
    o.destroy();
  });

  test("AvatarMark: person, agent and tempra; small", () => {
    for (const [kind, cls] of [
      ["person", "avatar-mark"],
      ["agent", "avatar-mark agent"],
      ["tempra", "avatar-mark agent tempra"],
    ] as const) {
      const d = draw(AvatarMark, { kind, initials: "AN" });
      const m = one(d.host, "span");
      expect(m.className).toBe(cls);
      expect(m.textContent).toBe("AN");
      expect(m.getAttribute("aria-hidden")).toBe("true");
      d.destroy();
    }
    const s = draw(AvatarMark, { initials: "A", size: "small" });
    expect(one(s.host, "span").className).toBe("avatar-mark small");
    s.destroy();
  });

  test("Tile: its letter; small, large, shared", () => {
    const d = draw(Tile, { letter: "D" });
    expect(one(d.host, "span").className).toBe("lib-tile");
    expect(one(d.host, "span").textContent).toBe("D");
    d.destroy();
    const s = draw(Tile, { letter: "D", size: "small", shared: true });
    expect(one(s.host, "span").className).toBe("lib-tile small shared");
    s.destroy();
    const l = draw(Tile, { letter: "D", size: "large" });
    expect(one(l.host, "span").className).toBe("lib-tile large");
    l.destroy();
  });

  test("Mark: three plates, the small cut on request, decorative unless named, and as a string", () => {
    const d = draw(Mark, {});
    const svg = one(d.host, "svg");
    expect(svg.getAttribute("class")).toBe("mark");
    expect(svg.getAttribute("aria-hidden")).toBe("true");
    expect([...svg.querySelectorAll("path")].map((p) => p.getAttribute("class"))).toEqual([
      "mark-back",
      "mark-mid",
      "mark-front",
    ]);
    const standard = svg.querySelector(".mark-back")?.getAttribute("d");
    d.destroy();
    const s = draw(Mark, { small: true, label: "Tempra", class: "brand" });
    const named = one(s.host, "svg");
    expect(named.getAttribute("class")).toBe("mark brand");
    expect(named.getAttribute("role")).toBe("img");
    expect(named.getAttribute("aria-label")).toBe("Tempra");
    expect(named.querySelector(".mark-back")?.getAttribute("d")).not.toBe(standard);
    // No ids (any number of marks on a page) and nothing inline: the colours are the CSS's.
    expect(named.querySelector("[id], [style], [fill]")).toBeNull();
    s.destroy();
    const html = markSvg({ small: true, label: 'A "b"' });
    expect(html).toContain('class="mark"');
    expect(html).toContain('aria-label="A &#34;b&#34;"');
    expect(html).toContain('class="mark-front"');
    expect(markSvg()).toContain('aria-hidden="true"');
  });

  test("Badge: the count, 99+ past 99, nothing at 0", () => {
    const d = draw(Badge, { count: 3 });
    expect(one(d.host, ".badge").textContent).toBe("3");
    d.destroy();
    const many = draw(Badge, { count: 120 });
    expect(one(many.host, ".badge").textContent).toBe("99+");
    many.destroy();
    const none = draw(Badge, { count: 0 });
    expect(none.host.querySelector(".badge")).toBeNull();
    none.destroy();
  });

  test("CommentMark: the count, named in words, a class beside its own", () => {
    let opened = 0;
    const d = draw(CommentMark, { count: 1, class: "end", onclick: () => opened++ });
    const b = one(d.host, "button");
    expect(b.className).toBe("comment-mark end");
    expect(b.getAttribute("aria-label")).toBe("1 comment");
    expect(b.getAttribute("title")).toBe("1 open comment");
    expect(b.textContent).toBe("1");
    b.click();
    expect(opened).toBe(1);
    d.destroy();
    const many = draw(CommentMark, { count: 4 });
    expect(one(many.host, "button").getAttribute("aria-label")).toBe("4 comments");
    many.destroy();
  });
});

describe("choices and panels", () => {
  test("Segmented: one pressed button per option in a named group; a choice moves it", () => {
    const changes: string[] = [];
    const d = draw(Segmented, {
      label: "Threads",
      options: [
        { value: "open", label: "Open" },
        { value: "resolved", label: "Resolved 2" },
      ],
      value: "open",
      onchange: (v: string) => changes.push(v),
    });
    const group = one(d.host, "fieldset.segmented");
    expect(one(group, "legend").textContent).toBe("Threads");
    const buttons = [...group.querySelectorAll("button")];
    expect(buttons.map((b) => b.getAttribute("aria-pressed"))).toEqual(["true", "false"]);
    expect(buttons.every((b) => b.hasAttribute("data-stay"))).toBe(true);
    buttons[1]?.click();
    flushSync();
    expect(changes).toEqual(["resolved"]);
    expect(buttons.map((b) => b.getAttribute("aria-pressed"))).toEqual(["false", "true"]);
    // The chosen one again changes nothing.
    buttons[1]?.click();
    expect(changes).toEqual(["resolved"]);
    d.destroy();
  });

  test("Select: a native select named by its label, a pill by default, groups, a choice", () => {
    const changes: string[] = [];
    const d = draw(Select, {
      label: "Who",
      value: "agents",
      options: [
        { value: "everyone", label: "Anyone" },
        { value: "agents", label: "Agents" },
        { group: "Who worked here", options: [{ value: "actor:a", label: "Claude" }] },
      ],
      onchange: (v: string) => changes.push(v),
    });
    const sel = one(d.host, "select") as HTMLSelectElement;
    expect(sel.classList.contains("pill-select")).toBe(true);
    expect(sel.getAttribute("aria-label")).toBe("Who");
    expect(sel.value).toBe("agents");
    expect(one(sel, "optgroup").getAttribute("label")).toBe("Who worked here");
    expect([...sel.options].map((o) => o.textContent)).toEqual(["Anyone", "Agents", "Claude"]);
    sel.value = "actor:a";
    sel.dispatchEvent(new Event("change", { bubbles: true }));
    flushSync();
    expect(changes).toEqual(["actor:a"]);
    d.destroy();
    // plain is a form's field; a consumer putting the value back keeps it (a change to confirm).
    const kept: string[] = [];
    const p = draw(Select, {
      variant: "plain",
      name: "role",
      value: "read",
      options: [
        { value: "read", label: "Read" },
        { value: "write", label: "Write" },
      ],
      onchange: (v: string, e: Event & { currentTarget: HTMLSelectElement }) => {
        kept.push(v);
        e.currentTarget.value = "read";
      },
    });
    const ps = one(p.host, "select") as HTMLSelectElement;
    expect(ps.className).toBe("");
    expect(ps.name).toBe("role");
    ps.value = "write";
    ps.dispatchEvent(new Event("change", { bubbles: true }));
    flushSync();
    expect(kept).toEqual(["write"]);
    expect(ps.value).toBe("read");
    p.destroy();
  });

  test("ChangeRow: lead, line, detail and when; continued drops the lead; live", () => {
    const d = draw(ChangeRow, {
      lead: text("AV"),
      children: text("Claude edited Revenue"),
      detail: text("a note"),
      when: text("just now"),
    });
    const row = one(d.host, "article.change-row");
    expect(one(row, ".change-row-lead").textContent).toBe("AV");
    expect(one(row, "p.change-row-line").textContent).toBe("Claude edited Revenue");
    expect(one(row, ".change-row-body").textContent).toContain("a note");
    expect(one(row, ".change-row-when").textContent).toBe("just now");
    d.destroy();
    const c = draw(ChangeRow, {
      lead: text("AV"),
      children: text("Added X"),
      continued: true,
      live: true,
    });
    const crow = one(c.host, "article.change-row");
    expect(crow.classList.contains("continued")).toBe(true);
    expect(crow.classList.contains("live")).toBe(true);
    expect(one(crow, ".change-row-lead").textContent).toBe("");
    expect(crow.querySelector(".change-row-when")).toBeNull();
    c.destroy();
  });

  test("PanelHead: its title as a focusable h2, the count, × named for the panel", () => {
    let closed = 0;
    const d = draw(PanelHead, { title: "Comments", count: "3 open", onClose: () => closed++ });
    const head = one(d.host, "header.panel-head");
    expect(one(head, "h2").textContent).toBe("Comments");
    expect(one(head, "h2").getAttribute("tabindex")).toBe("-1");
    expect(one(head, ".count").textContent).toBe("3 open");
    const close = one(head, "button.icon-button.touch");
    expect(close.getAttribute("aria-label")).toBe("Close comments");
    expect(close.getAttribute("title")).toBe("Close");
    close.click();
    expect(closed).toBe(1);
    d.destroy();
    const bare = draw(PanelHead, { title: "History", onClose: () => {} });
    expect(bare.host.querySelector(".count")).toBeNull();
    bare.destroy();
  });

  test("Dialog: a modal named by its title, × closing it", () => {
    let closed = 0;
    const d = draw(Dialog, {
      title: "A dialog",
      open: true,
      onClose: () => closed++,
      children: text("Body"),
    });
    const dialog = one(d.host, "dialog.dialog");
    const h2 = one(dialog, "h2");
    expect(h2.textContent).toBe("A dialog");
    expect(dialog.getAttribute("aria-labelledby")).toBe(h2.id);
    const close = one(dialog, "button.icon-button");
    expect(close.getAttribute("aria-label")).toBe("Close");
    close.click();
    expect(closed).toBe(1);
    d.destroy();
  });
});

describe("the catalogue (/_dev/design)", () => {
  test("is the app's page at /_dev/design, and nothing else under /_dev/ is", () => {
    expect(match(new URL("http://localhost/_dev/design"))).toEqual({ page: "design" });
    expect(match(new URL("http://localhost/_dev/mail"))).toBeNull();
  });

  test("draws every component in a light and a dark column", async () => {
    const d = draw(Design, {});
    await settle();
    const light = one(d.host, ".catalogue-theme.theme-light");
    const dark = one(d.host, ".catalogue-theme.theme-dark");
    for (const col of [light, dark]) {
      const names = [...col.querySelectorAll(".catalogue-item > h2")].map((h) => h.textContent);
      for (const name of [
        "Icon",
        "Button",
        "PillButton",
        "ToolPill",
        "IconButton",
        "SplitButton",
        "Disclosure",
        "SearchButton",
        "Field and TextInput",
        "SearchField",
        "Chip",
        "Segmented",
        "Select",
        "ChangeRow",
        "Notice",
        "AvatarMark",
        "Tile",
        "Mark",
        "Badge",
        "Menu",
        "Dialog and ComposeDialog",
        "PanelHead",
        "CommentMark",
      ]) {
        expect(names).toContain(name);
      }
    }
    // Nothing styled inline: every look is the design CSS's.
    expect(d.host.querySelector("[style]")).toBeNull();
    d.destroy();
  });
});
