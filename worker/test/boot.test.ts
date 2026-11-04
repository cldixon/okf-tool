import { describe, expect, test } from "bun:test";
import { bootData, bootKey, bootScript, bootUrls } from "../src/ui/boot";

describe("the shell's boot data (TEMPRA-175)", () => {
  test("keys are the path and the query sorted by name", () => {
    expect(bootKey("/api/v1/x?b=2&a=1")).toBe("/api/v1/x?a=1&b=2");
    expect(bootKey("/api/v1/x")).toBe("/api/v1/x");
    expect(bootKey("http://localhost/api/v1/x?path=a%2Fb.md")).toBe("/api/v1/x?path=a%2Fb.md");
  });

  test("a file's page asks for its page first (one call, TEMPRA-191), a page's threads, then the frame", () => {
    const urls = bootUrls({ kind: "file", owner: "ann", slug: "notes", path: "a b/c.md" });
    expect(urls[0]).toBe("/api/v1/libraries/ann/notes/page/a%20b/c.md");
    expect(urls[1]).toStartWith("/api/v1/libraries/ann/notes/comments?");
    expect(urls).toContain("/api/v1/me");
    for (const old of ["/files/", "/stats", "/sources/", "/links/", "/history/"]) {
      expect(urls.some((u) => u.includes(old))).toBe(false);
    }
    expect(bootUrls({ kind: "file", owner: "a", slug: "b", path: "c.md", at: 3 })[0]).toBe(
      "/api/v1/libraries/a/b/page/c.md?at=3",
    );
    // Not a page: no comments.
    const png = bootUrls({ kind: "file", owner: "ann", slug: "notes", path: "img/x.png" });
    expect(png[0]).toBe("/api/v1/libraries/ann/notes/page/img/x.png");
    expect(png.some((u) => u.includes("/comments"))).toBe(false);
    expect(
      bootUrls({ kind: "file", owner: "a", slug: "b", path: "d/index.md" }).some((u) =>
        u.includes("/comments"),
      ),
    ).toBe(false);
  });

  test("keeps 200 JSON answers in order within the budget, drops failures and late ones", async () => {
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      });
    const data = await bootData(
      ["/a", "/b", "/c", "/d", "/e"],
      async (url) => {
        if (url === "/b") return json({ error: "no" }, 404);
        if (url === "/c") throw new Error("down");
        if (url === "/d") return new Promise<Response>(() => {});
        if (url === "/e") return json({ big: "x".repeat(100) });
        return json({ ok: url });
      },
      { budget: 50, waitMs: 50 },
    );
    expect(data).toEqual({ "/a": { ok: "/a" } });
  });

  test("the block escapes what could end it or start markup", () => {
    const html = bootScript({ "/x": { s: "</script><!-- &  " } });
    expect(html).toStartWith('<script type="application/json" id="tempra-boot">');
    expect(html.match(/<\/script>/g)?.length).toBe(1);
    expect(html).not.toContain("<!--");
    expect(html).not.toContain(" ");
    const inner = html.slice(html.indexOf(">") + 1, html.lastIndexOf("</script>"));
    expect(JSON.parse(inner)).toEqual({ "/x": { s: "</script><!-- &  " } });
    expect(bootScript({})).toBe("");
  });
});
