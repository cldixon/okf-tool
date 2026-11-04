/**
 * The page panel (tempra-dev: app/page-panel): `show` names an MCP App that draws one page in the
 * chat, read only; its resource declares this deployment for its fonts and images, and its result
 * carries the page for the panel (the tree, sources, byline and signed image links).
 */
import { describe, expect, test } from "bun:test";
import { MCP_APP_MIME, PAGE_PANEL_URI } from "../src/mcp/server";
import { setup } from "./harness";
import { makePng } from "./images";
import { approve, connectApp } from "./oauth-flow";
import { attachFile } from "./upload";

type S = ReturnType<typeof setup>;
type Page = {
  library: { owner: string; slug: string };
  page: {
    path: string;
    title: string;
    description: string | null;
    status: string | null;
    images: Record<string, { src: string | null }>;
  };
  sources: { id: string; title: string | null; resource: string | null }[];
  byline: { name: string; agent: boolean; at: string } | null;
};

async function seed(s: S, body: string) {
  const r = await s.req("/files/metrics/margin.md", {
    method: "PUT",
    headers: { "Content-Type": "text/markdown" },
    body: `---\ntype: Metric\ntitle: Margin\ndescription: Gross margin.\nstatus: draft\nsources:\n  - id: book\n    title: The book\n    resource: https://example.com/book\n---\n${body}`,
  });
  expect(r.status).toBeLessThan(300);
}

/** A person's agent over OAuth: the connection a chat has. */
async function agent(s: S) {
  const { client } = await connectApp(s.app, approve);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await client.callTool({ name, arguments: args });
    const text = (r.content as { text: string }[]).map((c) => c.text).join("\n");
    return { text, isError: !!r.isError, page: (r.structuredContent as { page?: Page })?.page };
  };
  return { client, call };
}

describe("the page panel", () => {
  test("show names the panel; the resource is an MCP App with its CSP and Inter", async () => {
    const s = setup();
    const { client } = await agent(s);
    const tools = (await client.listTools()).tools;
    expect(tools.find((t) => t.name === "show")?._meta).toEqual({
      ui: { resourceUri: PAGE_PANEL_URI },
    });
    const read = await client.readResource({ uri: PAGE_PANEL_URI });
    const [content] = read.contents as { mimeType: string; text: string; _meta?: unknown }[];
    expect(content?.mimeType).toBe(MCP_APP_MIME);
    expect(content?._meta).toEqual({
      ui: { csp: { resourceDomains: ["http://localhost"] }, prefersBorder: true },
    });
    expect(content?.text).toStartWith("<!doctype html>");
    expect(content?.text).toContain('<body class="page-body">');
    // Inter from this deployment, never from a relative URL the host's frame cannot resolve.
    expect(content?.text).toContain('url("http://localhost/_design/inter-latin-opsz-normal.');
    expect(content?.text).not.toContain('url("/_design/');
    // Pele from this deployment's own chunk, the placeholder filled in.
    expect(content?.text).toMatch(/http:\/\/localhost\/_app\/pele-[\w-]+\.js/);
    expect(content?.text).not.toContain("__TEMPRA_ORIGIN__");
    expect(content?.text.match(/<\/script>/g)?.length).toBe(1);
  });

  test("show gives the panel the page, its sources, byline and signed images", async () => {
    const s = setup();
    const { call } = await agent(s);
    await attachFile(s.app, call, "metrics/chart.png", makePng(4, 3));
    await seed(s, "Margin is revenue minus cost.[^book]\n\n![A chart](/metrics/chart.png)\n");
    const r = await call("show", { path: "metrics/margin.md" });
    expect(r.isError).toBe(false);
    expect(r.text).toContain('Showing "Margin" (metrics/margin.md)');
    expect(r.text).toContain("http://localhost/owner/demo/metrics/margin.md");
    const page = r.page as Page;
    expect(page.library).toEqual({ owner: "owner", slug: "demo" });
    expect(page.page).toMatchObject({
      title: "Margin",
      description: "Gross margin.",
      status: "draft",
    });
    expect(page.sources).toEqual([
      { id: "book", title: "The book", resource: "https://example.com/book" },
    ]);
    expect(page.byline).toMatchObject({ name: "claude-code", agent: true });
    const src = page.page.images["metrics/chart.png"]?.src ?? "";
    expect(src).toStartWith("http://localhost/dl/lib-1/");
    // The signed link loads the image with no session.
    const img = await s.anon.request(src);
    expect(img.status).toBe(200);
    expect(img.headers.get("Content-Type")).toBe("image/png");
  });

  test("an agent's version is named for whom it acts", async () => {
    const s = setup();
    const { call } = await agent(s);
    await call("write", {
      path: "notes/a.md",
      content: "---\ntype: Note Set\ntitle: A\ndescription: An a.\n---\nWords.\n",
    });
    const page = (await call("show", { path: "notes/a.md" })).page as Page;
    expect(page.byline).toMatchObject({ name: "Claude for @owner", agent: true });
  });

  test("show refuses what is not a page", async () => {
    const s = setup();
    const { call } = await agent(s);
    await attachFile(s.app, call, "metrics/chart.png", makePng(4, 3));
    const r = await call("show", { path: "metrics/chart.png" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("not_page");
  });
});
