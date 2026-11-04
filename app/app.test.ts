import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { HEADERS, moduleSource, PUBLIC } from "./build";
import { pagePanel } from "./dist/panels";
import { actorView, personNames } from "./src/agents";
import { initials, nameInitials, personInitials } from "./src/chrome";
import { versionHref } from "./src/page/history";
import { panelInUrl, threadInHash } from "./src/page/panel";
import { followsInPlace, match, pageKey } from "./src/router";
import { Urls } from "./src/urls";

const at = (path: string) => match(new URL(path, "http://localhost"));

describe("routes follow the server's URLs (tempra-dev: v2/urls-and-handles)", () => {
  test("library list, directories and files at their own paths", () => {
    expect(at("/")).toEqual({ page: "libraries", create: false });
    expect(at("/ann/notes/")).toMatchObject({ page: "directory", dir: "", owner: "ann" });
    expect(at("/ann/notes/a/b/")).toMatchObject({ page: "directory", dir: "a/b" });
    expect(at("/ann/notes/a/b.md?at=4")).toMatchObject({ page: "file", path: "a/b.md", at: 4 });
    expect(at("/ann/notes/a%20b/c.md")).toMatchObject({ page: "file", path: "a b/c.md" });
  });

  test("a page in review mode, or against an earlier version (take 3)", () => {
    const urls = new Urls("ann", "notes");
    expect(at(urls.review("a/b.md"))).toMatchObject({ compare: { kind: "review" } });
    expect(at(urls.since("a/b.md", 7))).toMatchObject({ compare: { kind: "since", seq: 7 } });
    expect(at(urls.file("a/b.md"))).toMatchObject({ page: "file", compare: undefined });
    expect(at(urls.thread("a/b.md", "t1"))).toMatchObject({ page: "file", path: "a/b.md" });
    // The old `-/needs` URL lands on the library's home: the bell holds what waits (TEMPRA-189).
    expect(at("/ann/notes/-/needs")).toEqual({ page: "redirect", to: "/ann/notes/" });
    expect(at(urls.activity())).toMatchObject({
      page: "activity",
      filters: { view: "summary", who: "everyone" },
    });
    const filtered = urls.activity({ who: "agents", prefix: "app" });
    expect(filtered).toBe("/ann/notes/-/activity?who=agents&prefix=app");
    expect(at(filtered)).toMatchObject({
      filters: { view: "summary", who: "agents", prefix: "app" },
    });
  });

  test("Activity's two views and their filters, in the URL (take 4, TEMPRA-115)", () => {
    const urls = new Urls("ann", "notes");
    const events = urls.activity({ view: "events", who: "people", kind: "edit", q: "reader" });
    expect(events).toBe("/ann/notes/-/activity?view=events&who=people&kind=edit&q=reader");
    expect(at(events)).toMatchObject({
      page: "activity",
      filters: { view: "events", who: "people", kind: "edit", q: "reader" },
      done: null,
    });
    // The ledger's address opens Every event, keeping its filters and the revert notice.
    expect(at(urls.ledger())).toMatchObject({ page: "activity", filters: { view: "events" } });
    expect(urls.ledger({ actor: "claude-code" })).toBe("/ann/notes/-/ledger?actor=claude-code");
    // The Summary leaves the default out of its URL; take 3's comments filter is gone.
    expect(urls.activity({ view: "summary" })).toBe("/ann/notes/-/activity");
    expect(at("/ann/notes/-/activity?comments=hide")?.page).toBe("activity");
    expect(urls.ledgerJsonl()).toBe("/ann/notes/-/ledger.jsonl");
  });

  test("paths that start with -/ use the pages' own prefixes", () => {
    expect(at("/ann/notes/-/tree/-/x/")).toMatchObject({ page: "directory", dir: "-/x" });
    expect(at("/ann/notes/-/files/-/x.md")).toMatchObject({ page: "file", path: "-/x.md" });
    expect(at("/ann/notes/-/diff/a.md?from=2&to=5")).toMatchObject({
      page: "diff",
      path: "a.md",
      from: 2,
      to: 5,
    });
    expect(at("/ann/notes/-/ledger?actor=x&before=9&done=revert&n=2")).toMatchObject({
      page: "activity",
      filters: { view: "events", actor: "x" },
      done: { kind: "revert", n: 2 },
    });
  });

  test("the account's pages and every library page are the app's (TEMPRA-14)", () => {
    expect(at("/agents")).toEqual({ page: "agents", newToken: false, library: null });
    expect(at("/agents?new=token&library=ann%2Fnotes")).toEqual({
      page: "agents",
      newToken: true,
      library: "ann/notes",
    });
    // Connect an agent, Tokens and Connected apps became Agents.
    expect(at("/connect")).toEqual({ page: "redirect", to: "/agents" });
    expect(at("/apps")).toEqual({ page: "redirect", to: "/agents" });
    expect(at("/tokens")).toEqual({ page: "redirect", to: "/agents" });
    expect(at("/tokens?library=ann/notes")).toEqual({
      page: "redirect",
      to: "/agents?new=token&library=ann%2Fnotes",
    });
    expect(at("/account?done=email")).toEqual({ page: "account", done: "email" });
    // For agents is retired (TEMPRA-144): its address lands on the library's home.
    expect(at("/ann/notes/-/work?kind=lint")).toEqual({ page: "redirect", to: "/ann/notes/" });
    expect(at("/ann/notes/-/revert/req_1")).toMatchObject({ page: "revert", request: "req_1" });
    expect(at("/ann/notes/-/restore/a/b.md?to=4")).toMatchObject({
      page: "restore",
      path: "a/b.md",
      to: 4,
    });
    expect(at("/invitations")).toEqual({ page: "invitations" });
    // No Inbox page (TEMPRA-189): notifications are the bell's panel; its old links land on `/`.
    expect(at("/inbox")).toEqual({ page: "redirect", to: "/" });
    expect(at("/inbox?done=1&library=ann/notes")).toEqual({ page: "redirect", to: "/" });
    expect(at("/notifications")).toEqual({ page: "redirect", to: "/account#email" });
    for (const p of ["activity", "settings"]) {
      expect(at(`/ann/notes/-/${p}`)).toMatchObject({ page: p, owner: "ann", slug: "notes" });
    }
    // Settings is one page (2026-10-28): the former tabs' URLs open it at their section.
    for (const p of ["members", "connect", "transfer", "recovery", "delete"] as const) {
      expect(at(`/ann/notes/-/${p}`)).toEqual({
        page: "settings",
        owner: "ann",
        slug: "notes",
        section: p,
      });
    }
    expect(at("/ann/notes/-/settings")).toEqual({ page: "settings", owner: "ann", slug: "notes" });
  });

  test("server pages and downloads are left to the server", () => {
    for (const p of [
      "/sign-in",
      "/authorize",
      "/account/email/confirm",
      "/ann/notes",
      "/ann/notes/-/raw/a.md",
      "/ann/notes/-/download/a.png",
      "/ann/notes/-/export",
      "/ann/notes/-/exports/2026-10-01/bundle.tar",
      "/ann/notes/-/ledger/x",
      "/ann/notes/-/ledger.jsonl",
    ]) {
      expect(at(p)).toBeNull();
    }
  });

  test("Urls round-trip through match", () => {
    const u = new Urls("ann", "notes");
    expect(at(u.file("a/b.md"))).toMatchObject({ page: "file", path: "a/b.md" });
    expect(at(u.file("-/x.md"))).toMatchObject({ page: "file", path: "-/x.md" });
    expect(at(u.tree("-/d"))).toMatchObject({ page: "directory", dir: "-/d" });
    expect(at(u.pinned(3).tree("d"))).toMatchObject({ page: "directory", dir: "d", at: 3 });
    expect(u.api("tree", { prefix: "a b", at: undefined })).toBe(
      "/api/v1/libraries/ann/notes/tree?prefix=a+b",
    );
  });
});

test("the generated module names the bundle by its content hash", () => {
  const a = moduleSource("console.log(1)");
  expect(a).toMatch(/export const hash = "[0-9a-f]{12}";/);
  expect(a).not.toBe(moduleSource("console.log(2)"));
  // Code-split: the entry keeps the name Vite hashed it by, which its chunks import it by.
  const b = moduleSource("x", { "pele-abc.js": "y" }, "app.BHyq_u-v.js");
  expect(b).toContain('export const hash = "BHyq_u-v";');
  expect(b).toContain('export const chunks: string[] = ["pele-abc.js"];');
  // Names only: the code is a static asset (TEMPRA-174), not a string in the Worker.
  expect(b).not.toContain('"y"');
});

test("the page panel loads Pele from the deployment, the app's chunk alone (tempra-dev app/page-panel)", () => {
  const files = readdirSync(join(PUBLIC, "_app"));
  const pele = files.find((f) => /^pele-[\w-]+\.js$/.test(f));
  expect(pele).toBeDefined();
  // The chunk never imports the app's entry, which would bring the whole app into the panel.
  const code = readFileSync(join(PUBLIC, "_app", pele as string), "utf8");
  expect(code).not.toMatch(/from\s*["'`]\.\/app\./);
  // The panel imports it at the origin the Worker writes in, and carries no Pele of its own.
  expect(pagePanel).toContain(`__TEMPRA_ORIGIN__/_app/${pele}`);
  expect(pagePanel.length).toBeLessThan(900 * 1024);
  // A host's frame is another origin: the bundle answers it, as the design files do.
  expect(HEADERS).toMatch(/\/_app\/\*\n(?: {2}.*\n)*? {2}Access-Control-Allow-Origin: \*\n/);
});

describe("links followed in place (TEMPRA-129)", () => {
  const here = "http://localhost";
  const inPlace = (path: string) => followsInPlace(new URL(path, here), here);

  test("any library's pages, the person's own or one shared with them (F-2)", () => {
    expect(inPlace("/dev/notes/a.md")).toBe(true);
    // Someone else's library, shared with the person: no reload, the frame stays.
    expect(inPlace("/ann/shared/a.md")).toBe(true);
    expect(inPlace("/ann/shared/-/activity")).toBe(true);
    expect(inPlace("/ann/shared/folder/")).toBe(true);
  });

  test("every account page, Notifications included (F-3)", () => {
    for (const p of [
      "/",
      "/inbox",
      "/notifications",
      "/account",
      "/agents",
      "/invitations",
      "/welcome",
    ]) {
      expect(inPlace(p)).toBe(true);
    }
  });

  test("downloads, server pages and other sites load in full", () => {
    for (const p of ["/ann/shared/-/raw/a.md", "/ann/shared/-/ledger.jsonl", "/sign-out"]) {
      expect(inPlace(p)).toBe(false);
    }
    expect(followsInPlace(new URL("https://example.com/ann/shared/a.md"), here)).toBe(false);
  });
});

describe("the page view (TEMPRA-128)", () => {
  const urls = new Urls("ann", "notes");
  const v = (n: number, seq: number) => ({
    n,
    event: {
      seq,
      ts: "2026-10-20T10:00:00Z",
      actor: "claude-code/dev",
      op: "edit",
      path: "a.md",
      hash: null,
      meta: null,
    },
  });
  const versions = [v(1, 3), v(2, 8), v(3, 15), v(4, 20)];
  const params = (href: string) => new URL(href, "http://localhost").searchParams;

  test("a version in History shows what it changed: the version before it to it (C-1)", () => {
    // v3: v3 as it was (seq 15), drawn against v2 (seq 8); History stays open.
    const v3 = versionHref(urls, "a.md", versions, 3);
    expect(params(v3).get("at")).toBe("15");
    expect(params(v3).get("since")).toBe("8");
    expect(params(v3).get("panel")).toBe("history");
    expect(at(v3)).toMatchObject({ page: "file", at: 15, compare: { kind: "since", seq: 8 } });
    // The latest is the page itself, against the version before it.
    const v4 = params(versionHref(urls, "a.md", versions, 4));
    expect(v4.get("at")).toBeNull();
    expect(v4.get("since")).toBe("15");
    // The first has nothing before it: it opens as it was.
    const v1 = params(versionHref(urls, "a.md", versions, 1));
    expect(v1.get("at")).toBe("3");
    expect(v1.get("since")).toBeNull();
  });

  test("a heading's id is never taken for a panel or a thread (C-2)", () => {
    const none = new Set<string>();
    const headings = new Set(["comments", "thread-1", "sources"]);
    const where = (hash: string, search = "") => ({ search, hash });
    // Links that ask for the Comments panel or a thread.
    expect(panelInUrl(none, where("#comments"))).toBe("comments");
    expect(panelInUrl(none, where("#thread-t1"))).toBe("comments");
    expect(threadInHash(none, "#thread-t1")).toBe("t1");
    expect(threadInHash(none, "#thread-a%20b")).toBe("a b");
    // The same fragments naming a heading in the body go to the heading.
    expect(panelInUrl(headings, where("#comments"))).toBeNull();
    expect(panelInUrl(headings, where("#thread-1"))).toBeNull();
    expect(threadInHash(headings, "#thread-1")).toBeNull();
    // ?panel= asks plainly, whatever the fragment.
    expect(panelInUrl(headings, where("#comments", "?panel=history"))).toBe("history");
    expect(panelInUrl(none, where(""))).toBeNull();
  });

  test("another file is another page; how one is shown is not (C-3)", () => {
    const key = (path: string) => {
      const url = new URL(path, "http://localhost");
      return pageKey(url, match(url));
    };
    expect(key("/ann/notes/a.md")).not.toBe(key("/ann/notes/b.md"));
    expect(key("/ann/notes/a.md")).toBe(key("/ann/notes/a.md?panel=history"));
    expect(key("/ann/notes/a.md")).toBe(key("/ann/notes/a.md?since=4#thread-t1"));
    expect(key("/ann/notes/a.md")).not.toBe(key("/ann/notes/a.md?at=4"));
  });

  test("the signed-in person's mark is their initials, never YO for You (C-7)", () => {
    const me = actorView("human:dev", null, {}, "human:dev");
    expect(me.name).toBe("You");
    expect(initials(me.mark)).toBe("DE");
    expect(initials(actorView("human:ann_lee", null, {}, "human:dev").mark)).toBe("AL");
  });

  test("initials come from the account's name when given, else the handle (TEMPRA-54)", () => {
    expect(nameInitials("Ann Lee Smith")).toBe("AS");
    expect(nameInitials("  ann   lee ")).toBe("AL");
    expect(nameInitials("Ann")).toBe("A");
    expect(nameInitials("Émile Zola")).toBe("ÉZ");
    expect(nameInitials("😀 Smith")).toBe("😀S");
    expect(nameInitials("")).toBe("?");
    expect(personInitials("cl_dixon", "Chris Dixon")).toBe("CD");
    expect(personInitials("sam", "Ann")).toBe("A");
    expect(personInitials("sam", null)).toBe("SA");
    expect(personInitials("sam", "  ")).toBe("SA");
    // Others' names come from the library's people, by handle; text still names the handle.
    const names = personNames([
      {
        person: "ann_lee",
        person_name: "Ann Smith",
        agent: null,
        actor: "human:ann_lee",
        requests: 1,
        last_ts: "",
      },
      { person: "bo", person_name: null, agent: null, actor: "human:bo", requests: 1, last_ts: "" },
    ]);
    expect(names).toEqual({ ann_lee: "Ann Smith" });
    const ann = actorView("human:ann_lee", null, {}, "human:dev", names);
    expect(ann).toMatchObject({ name: "ann_lee", mark: "ann_lee", fullName: "Ann Smith" });
    expect(personInitials(ann.mark, ann.fullName)).toBe("AS");
    expect(actorView("human:bo", null, {}, "human:dev", names).fullName).toBeNull();
  });
});
