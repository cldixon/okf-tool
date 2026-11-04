import { afterEach, describe, expect, test } from "bun:test";
import { chosenLibrary, monthLines } from "./src/pages/account";
import ConnectSteps from "./src/pages/ConnectSteps.svelte";
import Invitations from "./src/pages/Invitations.svelte";
import { slugFrom } from "./src/pages/libraries";
import Members from "./src/pages/Members.svelte";
import { exportLabel, restoreTime, versionAt } from "./src/pages/manage";
import Welcome from "./src/pages/Welcome.svelte";
import { Urls } from "./src/urls";
import { draw, settle } from "./test/dom";

/** Answers the app's API calls from a table of paths, as the server would. */
function serve(answers: Record<string, unknown>) {
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input), "http://localhost/");
    const body = answers[url.pathname];
    if (body === undefined) return new Response('{"error":"not found"}', { status: 404 });
    return new Response(JSON.stringify(body), {
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  return () => {
    globalThis.fetch = real;
  };
}

const text = (el: Element) => (el.textContent ?? "").replace(/\s+/g, " ").trim();

let restore: (() => void) | null = null;
afterEach(() => {
  restore?.();
  restore = null;
  document.body.innerHTML = "";
});

describe("the Account page's month (TEMPRA-232)", () => {
  test("each quota in people's words", () => {
    const lines = monthLines({
      month: "2026-11",
      resets: "2026-12-01T00:00:00.000Z",
      writes: { used: 1203, limit: 100_000 },
      requests: { used: 15_000, limit: 1_000_000 },
      storage: { used: 12 * 1048576, limit: 1024 * 1048576 },
    });
    expect(lines.map((l) => `${l.label}: ${l.text}`)).toEqual([
      "Writes this month: 1,203 of 100,000",
      "Tool calls and API requests this month: 15,000 of 1,000,000",
      "Storage: 12 MB of 1024 MB",
    ]);
  });
});

describe("slugFrom", () => {
  test("a name becomes an address", () => {
    expect(slugFrom("Gate Notes & Plans")).toBe("gate-notes-plans");
    expect(slugFrom("  Café  ")).toBe("cafe");
    expect(slugFrom("--Hello--")).toBe("hello");
    expect(slugFrom("")).toBe("");
  });
  test("at most 63 characters, never ending in a dash", () => {
    const s = slugFrom(`${"a".repeat(62)} b`);
    expect(s.length).toBeLessThanOrEqual(63);
    expect(s.endsWith("-")).toBe(false);
  });
});

describe("the pages' pure parts", () => {
  test("New token picks ?library= by owner/slug or the person's own slug", () => {
    const me = { handle: "ann", email: "a@x", actor: "human:ann" };
    expect(chosenLibrary(["notes", "bob/plans"], null, me)).toBe("notes");
    expect(chosenLibrary(["notes", "bob/plans"], "bob/plans", me)).toBe("bob/plans");
    expect(chosenLibrary(["notes", "work"], "ann/work", me)).toBe("work");
    expect(chosenLibrary(["notes"], "cat/other", me)).toBe("notes");
  });
  test("exports and restores read as times", () => {
    expect(exportLabel("2026-09-30")).toBe("Sep 30");
    expect(exportLabel("2026-09-30-pre-restore-180211042")).toMatch(/, before a restore$/);
    expect(restoreTime("20260930T180211042Z")).toBe("2026-09-30T18:02:11Z");
  });
  test("a version is numbered among the content events", () => {
    const events = [
      { seq: 1, ts: "a", op: "write" },
      { seq: 2, ts: "b", op: "verify" },
      { seq: 4, ts: "c", op: "write" },
      { seq: 6, ts: "d", op: "comment" },
    ];
    expect(versionAt(events, 5)).toEqual({ n: 2, ts: "c" });
    expect(versionAt(events, 3)).toEqual({ n: 1, ts: "a" });
    expect(versionAt(events, 0)).toBeNull();
  });
});

describe("drawn", () => {
  test("Connect steps name the library and link New token to it", () => {
    const { host } = draw(ConnectSteps, { slug: "notes", library: "ann/notes" });
    expect(text(host)).toContain("When asked, choose All libraries, or select notes. ");
    expect(host.querySelector("a")?.getAttribute("href")).toBe(
      "/agents?new=token&library=ann%2Fnotes",
    );
  });

  test("first run asks for a handle and a library, with hints", () => {
    const { host } = draw(Welcome, {
      me: { handle: "ann", email: "a@x", actor: "human:ann" },
    });
    expect(host.querySelector("h1")?.textContent).toBe("Welcome");
    const handle = host.querySelector<HTMLInputElement>('input[name="handle"]');
    expect(handle?.value).toBe("ann");
    expect(host.querySelector('input[name="library"]')?.getAttribute("pattern")).toBe(
      "[a-z0-9][a-z0-9\\-]{0,62}",
    );
    expect(host.querySelector("label:has(input[name=starter])")?.textContent).toBe(
      " Add a guide page",
    );
    expect(text(host.querySelector("#welcome-library-hint") as Element)).toBe(
      "The last part of its address. Lowercase letters, digits and -.",
    );
  });

  test("an invitation reads as who invited, the library and the access", async () => {
    restore = serve({
      "/api/v1/invitations": {
        invitations: [
          {
            id: "i1",
            owner: "bob",
            slug: "plans",
            role: "write",
            handle: "bob",
            expires: "2026-11-30T00:00:00Z",
          },
        ],
      },
    });
    const { host } = draw(Invitations, {});
    await settle(10);
    expect(host.querySelector(".invitation-from > span:last-child")?.textContent).toBe(
      "@bob invited you",
    );
    expect(host.querySelector(".invitation-access")?.textContent).toBe(
      "Your accessCan read and write",
    );
    expect(host.querySelector(".lib-tile.shared")?.textContent).toBe("P");
    const buttons = [...host.querySelectorAll(".actions button")].map((b) => b.textContent);
    expect(buttons).toEqual(["Accept", "Decline"]);
  });

  test("Members: the owner's view, and a changed access waiting for its confirmation", async () => {
    restore = serve({
      "/api/v1/libraries/ann/notes/members": {
        owner: "ann",
        role: "owner",
        members: [{ handle: "bob", role: "read", created: "2026-10-01T00:00:00Z" }],
        invitations: [{ id: "v1", handle: "cat", role: "write", expires: "2026-11-30T00:00:00Z" }],
      },
      "/api/v1/libraries/ann/notes/agents": { contributors: [] },
      "/api/v1/libraries": { libraries: [] },
    });
    const { host } = draw(Members, { urls: new Urls("ann", "notes"), me: "ann" });
    await settle(10);
    const names = [...host.querySelectorAll("td.name")].map((t) => t.textContent);
    expect(names).toEqual(["@ann", "@bob"]);
    const select = host.querySelector<HTMLSelectElement>('select[aria-label="Access for @bob"]');
    expect(select?.value).toBe("read");
    expect(text(host.querySelector("li") as Element)).toBe(
      "@cat, read and write, open until Nov 30 Withdraw…",
    );
    expect(host.querySelector("h3 + p.muted")?.textContent).toBe("Nobody yet.");
    // Changing the access asks first; the select keeps showing the saved access meanwhile.
    if (!select) throw new Error("no select");
    select.value = "write";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    await settle();
    expect(select.value).toBe("read");
    const dialog = document.querySelector("dialog");
    expect(dialog?.querySelector("h2")?.textContent).toBe("Change @bob's access?");
    expect(text(dialog?.querySelector(".confirm-body") as Element)).toBe(
      "@bob and their agents will read and write here, from their next request.",
    );
  });
});
