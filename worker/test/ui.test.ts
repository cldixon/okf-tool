import { describe, expect, test } from "bun:test";
import { linkTarget, renderBody } from "../src/ui/markdown";
import { setup } from "./harness";

type S = ReturnType<typeof setup>;

async function put(s: S, path: string, content: string, note = "test") {
  const r = await s.req(`/files/${path}`, {
    method: "PUT",
    headers: { "Content-Type": "text/markdown", "X-Note": note },
    body: content,
  });
  expect(r.status).toBeLessThan(300);
  return r;
}

async function page(s: S, path: string) {
  const r = await s.app.request(path);
  return { status: r.status, html: await r.text(), headers: r.headers };
}

const LIB = "/app/libraries/demo";

describe("markdown rendering for the UI", () => {
  const opts = {
    url: (t: string) => {
      const l = linkTarget("a/b.md", t);
      if (!l) return null;
      return l.kind === "internal" ? `/ui/${l.path}${l.anchor ?? ""}` : l.href;
    },
    footnote: (label: string, defined: boolean) => (defined ? `#fn-${label}` : null),
  };

  test("never renders raw HTML or unsafe URLs", () => {
    const { html } = renderBody(
      [
        "<script>alert(1)</script>",
        "",
        'Hi <img src=x onerror="alert(1)"> [bad](javascript:alert(1)) [data](data:text/html,x)',
        "",
        "[ok](https://e.com) [rel](../c.md#h) ![pic](p.png)",
      ].join("\n"),
      opts,
    );
    expect(html).not.toContain("<script");
    expect(html).not.toContain('<img src="x"');
    expect(html).toContain("&#x3C;script>");
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("data:text");
    expect(html).toContain('href="https://e.com" rel="noopener noreferrer nofollow"');
    expect(html).toContain('href="/ui/c.md#h"');
    expect(html).toContain('src="/ui/a/p.png"');
  });

  test("tables, heading anchors and footnotes", () => {
    const r = renderBody(
      "# Schema\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\n# Schema\n\nClaim.[^s] Loose.[^x]\n\n[^s]: The **standard**\n",
      opts,
    );
    expect(r.html).toContain('<h1 id="schema">');
    expect(r.html).toContain('<h1 id="schema-1">');
    expect(r.html).toContain("<table>");
    expect(r.html).toContain('<sup class="fnref"><a href="#fn-s">[s]</a></sup>');
    // Without a definition GFM keeps it as text, as any renderer would; lint flags it.
    expect(r.html).toContain("Loose.[^x]");
    expect(r.footnotes.get("s")).toContain("<strong>standard</strong>");
  });
});

describe("built-in UI pages", () => {
  test("library list, directory and concept views", async () => {
    const s = setup();
    await put(s, "policies/margin.md", "---\ntype: Policy\ntitle: Margin Standard\n---\nRules.\n");
    await put(
      s,
      "metrics/gross-margin.md",
      [
        "---",
        "type: Metric",
        "title: Gross <Margin>",
        "description: Revenue minus COGS.",
        "stale_after: 2020-01-01T00:00:00Z",
        "sources:",
        "  - { id: std, resource: /policies/margin.md, title: Margin Standard }",
        "  - { id: web, resource: https://e.com/doc }",
        "---",
        "Uses [the policy](/policies/margin.md) and [missing](/nope.md).[^std] Also [^web].",
        "",
        "[^std]: FY2026 standard",
        "",
      ].join("\n"),
      "first draft",
    );

    const list = await page(s, "/app");
    expect(list.status).toBe(200);
    expect(list.headers.get("Content-Security-Policy")).toContain("default-src 'none'");
    expect(list.html).toContain('href="/app/libraries/demo/"');
    expect(list.html).toContain("owner@example.com");

    const root = await page(s, `${LIB}/`);
    expect(root.status).toBe(200);
    expect(root.html).toContain(`href="${LIB}/tree/metrics/"`);
    expect(root.html).toContain("<strong>2</strong>concepts");

    const dir = await page(s, `${LIB}/tree/metrics/`);
    expect(dir.html).toContain("Gross &#60;Margin&#62;");
    expect(dir.html).toContain("stale");
    expect(dir.html).toContain("unverified");

    const c = await page(s, `${LIB}/files/metrics/gross-margin.md`);
    expect(c.status).toBe(200);
    // Title escaped; body links point at UI pages; the broken one is flagged.
    expect(c.html).toContain("<h1>Gross &#60;Margin&#62;</h1>");
    expect(c.html).toContain(`href="${LIB}/files/policies/margin.md"`);
    expect(c.html).toContain("broken_link");
    // Footnotes resolve to the sources panel, with counts, definitions and signals.
    expect(c.html).toContain('<a href="#src-std">[std]</a>');
    expect(c.html).toContain('id="src-std"');
    expect(c.html).toContain("cited 1×");
    expect(c.html).toContain("FY2026 standard");
    expect(c.html).toContain("Margin Standard");
    // Frontmatter panel, history with the note, raw link.
    expect(c.html).toContain("<dt>stale_after</dt>");
    expect(c.html).toContain("first draft");
    expect(c.html).toContain(`href="${LIB}/raw/metrics/gross-margin.md"`);

    const policy = await page(s, `${LIB}/files/policies/margin.md`);
    expect(policy.html).toContain(`href="/app/libraries/demo/files/metrics/gross-margin.md"`);
    expect(policy.html).toContain("cites it");
  });

  test("time travel: ?at shows the version then, with a notice", async () => {
    const s = setup();
    await put(s, "a.md", "---\ntype: Note\n---\nFirst words.\n");
    const r = await s.req("/files/a.md", { headers: { Accept: "application/json" } });
    const { hash, seq } = (await r.json()) as { hash: string; seq: number };
    await s.req("/files/a.md", {
      method: "PUT",
      headers: { "Content-Type": "text/markdown", "If-Match": `"${hash}"` },
      body: "---\ntype: Note\n---\nSecond words.\n",
    });
    const now = await page(s, `${LIB}/files/a.md`);
    expect(now.html).toContain("Second words.");
    expect(now.html).not.toContain("Viewing as of");
    const then = await page(s, `${LIB}/files/a.md?at=${seq}`);
    expect(then.html).toContain("First words.");
    expect(then.html).toContain(`Viewing as of sequence ${seq}`);
    // Links on a pinned page stay pinned.
    expect(then.html).toContain(`${LIB}/raw/a.md?at=${seq}`);
    const raw = await s.app.request(`${LIB}/raw/a.md?at=${seq}`);
    expect(raw.headers.get("Content-Type")).toContain("text/plain");
    expect(await raw.text()).toContain("First words.");
  });

  test("attachments, synthesized files, and errors as pages", async () => {
    const s = setup();
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const up = await s.req("/files/img/logo.png", {
      method: "PUT",
      headers: { "Content-Type": "image/png" },
      body: png,
    });
    expect(up.status).toBeLessThan(300);
    const a = await page(s, `${LIB}/files/img/logo.png`);
    expect(a.html).toContain("image/png");
    expect(a.html).toContain(`src="${LIB}/download/img/logo.png"`);
    const dl = await s.app.request(`${LIB}/download/img/logo.png`, { redirect: "manual" });
    expect(dl.status).toBe(302);
    const bytes = await s.app.request(dl.headers.get("Location") ?? "");
    expect(new Uint8Array(await bytes.arrayBuffer())).toEqual(png);

    const index = await s.app.request(`${LIB}/files/img/index.md`, { redirect: "manual" });
    expect(index.headers.get("Location")).toBe(`${LIB}/tree/img/`);
    expect((await page(s, `${LIB}/files/log.md`)).html).toContain("Synthesized by the server");

    const missing = await page(s, `${LIB}/files/nope.md`);
    expect(missing.status).toBe(404);
    expect(missing.html).toContain("Back to libraries");
    expect((await page(s, "/app/libraries/other/")).status).toBe(404);
  });

  test("pages require an Access sign-in", async () => {
    const s = setup();
    Object.assign(s.env, {
      ACCESS_TEAM_DOMAIN: "https://team.cloudflareaccess.com",
      ACCESS_AUD: "a",
    });
    const r = await s.app.request("/app");
    expect(r.status).toBe(403);
    expect((await s.app.request(`${LIB}/files/a.md`)).status).toBe(403);
  });
});

async function json<T>(r: Response): Promise<T> {
  return (await r.json()) as T;
}

async function hashOf(s: S, path: string) {
  const r = await s.req(`/files/${path}`, { headers: { Accept: "application/json" } });
  return (await json<{ hash: string; seq: number }>(r)).hash;
}

async function submit(
  s: S,
  path: string,
  fields: Record<string, string>,
  origin = "http://localhost",
) {
  return s.app.request(path, {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields),
    redirect: "manual",
  });
}

describe("history, ledger and revert (Phase 3, slice 2)", () => {
  test("a leading heading that repeats the title is not shown twice", async () => {
    const s = setup();
    await put(
      s,
      "a.md",
      "---\ntype: Note\ntitle: Alpha\n---\n# Alpha\n\nBody text.\n\n# Alpha again\n",
    );
    const c = await page(s, `${LIB}/files/a.md`);
    expect(c.html).toContain("<h1>Alpha</h1>");
    expect(c.html).not.toContain('<h1 id="alpha">');
    expect(c.html).toContain("Alpha again");
    expect(c.html).toContain("Body text.");
  });

  test("diffs between versions, and since the last human verification", async () => {
    const s = setup();
    await put(s, "a.md", "---\ntype: Note\n---\nOne.\n", "first");
    const first = (
      await json<{ seq: number }>(
        await s.req("/files/a.md", { headers: { Accept: "application/json" } }),
      )
    ).seq;
    await s.store().verify({ actor: "human:owner", request_id: "v1" }, "a.md");
    await s.req("/files/a.md", {
      method: "PUT",
      headers: { "Content-Type": "text/markdown", "If-Match": `"${await hashOf(s, "a.md")}"` },
      body: "---\ntype: Note\n---\nTwo.\n",
    });
    const c = await page(s, `${LIB}/files/a.md`);
    expect(c.html).toContain("Changes since human verification");
    expect(c.html).toContain(`${LIB}/diff/a.md?to=${first}`);
    const d = await page(s, `${LIB}/diff/a.md`);
    expect(d.status).toBe(200);
    expect(d.html).toContain('<span class="del">-One.</span>');
    expect(d.html).toContain('<span class="add">+Two.</span>');
    const since = /href="([^"]*diff\/a\.md\?from=\d+)"/.exec(c.html)?.[1] ?? "";
    expect((await page(s, since.replace(/&amp;/g, "&"))).html).toContain("+Two.");
  });

  test("the ledger lists requests with filters and pages", async () => {
    const s = setup();
    await put(s, "notes/a.md", "---\ntype: Note\n---\nA\n", "add a");
    await put(s, "other/b.md", "---\ntype: Note\n---\nB\n", "add b");
    const all = await page(s, `${LIB}/ledger`);
    expect(all.html).toContain("add a");
    expect(all.html).toContain("add b");
    expect(all.html.indexOf("add b")).toBeLessThan(all.html.indexOf("add a"));
    const scoped = await page(s, `${LIB}/ledger?prefix=notes`);
    expect(scoped.html).toContain("add a");
    expect(scoped.html).not.toContain("add b");
    expect((await page(s, `${LIB}/ledger?actor=someone/else`)).html).toContain("No requests match");
    const today = new Date().toISOString().slice(0, 10);
    expect((await page(s, `${LIB}/ledger?from=${today}&to=${today}`)).html).toContain("add a");
    expect((await page(s, `${LIB}/ledger?to=2000-01-01`)).html).toContain("No requests match");
    expect((await page(s, `${LIB}/ledger?from=yesterday`)).status).toBe(400);
  });

  test("revert a request from the ledger, attributed to the signed-in human", async () => {
    const s = setup();
    await put(s, "a.md", "---\ntype: Note\n---\nGood.\n", "good version");
    await s.req("/files/a.md", {
      method: "PUT",
      headers: {
        "Content-Type": "text/markdown",
        "If-Match": `"${await hashOf(s, "a.md")}"`,
        "X-Note": "bad edit",
      },
      body: "---\ntype: Note\n---\nBad.\n",
    });
    const ledger = await page(s, `${LIB}/ledger`);
    const revertUrl = /href="([^"]*\/revert\/[^"]+)"/.exec(ledger.html)?.[1] ?? "";
    const confirm = await page(s, revertUrl);
    expect(confirm.html).toContain("Revert this request?");
    expect(confirm.html).toContain("bad edit");
    expect(confirm.html).toContain('<span class="add">+Bad.</span>');

    const forged = await submit(s, revertUrl, { note: "x" }, "https://evil.example");
    expect(forged.status).toBe(403);
    expect(await s.store().read("a.md")).toMatchObject({ body: "Bad.\n" });

    const done = await submit(s, revertUrl, { note: "undo the bad edit" });
    expect(done.status).toBe(303);
    expect(done.headers.get("Location")).toContain("done=revert");
    const r = s.store().read("a.md");
    expect(r).toMatchObject({ body: "Good.\n" });
    const after = await page(s, done.headers.get("Location") ?? "");
    expect(after.html).toContain("Reverted: 1 change");
    expect(after.html).toContain("human:owner");
    expect(after.html).toContain("undo the bad edit");
  });

  test("restore one file to an earlier version", async () => {
    const s = setup();
    await put(s, "a.md", "---\ntype: Note\n---\nFirst.\n");
    const first = (
      await json<{ seq: number }>(
        await s.req("/files/a.md", { headers: { Accept: "application/json" } }),
      )
    ).seq;
    await s.req("/files/a.md", {
      method: "PUT",
      headers: { "Content-Type": "text/markdown", "If-Match": `"${await hashOf(s, "a.md")}"` },
      body: "---\ntype: Note\n---\nSecond.\n",
    });
    const pinned = await page(s, `${LIB}/files/a.md?at=${first}`);
    expect(pinned.html).toContain(`${LIB}/restore/a.md?to=${first}`);
    const confirm = await page(s, `${LIB}/restore/a.md?to=${first}`);
    expect(confirm.html).toContain('<span class="add">+First.</span>');
    const done = await submit(s, `${LIB}/restore/a.md?to=${first}`, { note: "back to first" });
    expect(done.status).toBe(303);
    expect(s.store().read("a.md")).toMatchObject({ body: "First.\n" });
    expect((await page(s, done.headers.get("Location") ?? "")).html).toContain("Restored.");
  });
});
