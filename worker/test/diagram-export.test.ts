import { describe, expect, test } from "bun:test";
import { drawnDiagrams } from "../src/diagram-export";
import { runMaintenance } from "../src/maintain";
import { fakeRenderer } from "../src/render";
import { LibraryStore } from "../src/store/store";
import { readTar, writeTar } from "../src/util/tar";
import { memoryBucket, setup } from "./harness";
import { bunSqlHandle } from "./sqlite";

const doc = (body: string) => `---\ntype: Note\n---\n${body}`;
const FLOW = "```mermaid\nflowchart LR\n  A --> B\n```\n";
const SEQ = "```mermaid\nsequenceDiagram\n  A->>B: hi\n```\n";
// Figure 1 is an image, so the diagrams are figures 2 and 3.
const BODY = `# A\n\n![x](/pic.png)\n\n${FLOW}\nText.\n\n${SEQ}`;

const tarOf = async (r: Response) => {
  expect(r.status).toBe(200);
  return new Map(
    readTar(new Uint8Array(await r.arrayBuffer())).map((f) => [
      f.path,
      new TextDecoder().decode(f.bytes),
    ]),
  );
};

async function withDiagrams(s: ReturnType<typeof setup>) {
  for (const [path, body] of [
    ["notes/a.md", doc(BODY)],
    ["b.md", doc("No diagrams.\n")],
  ] as const) {
    expect((await s.req(`/files/${path}`, { method: "PUT", body })).status).toBe(200);
  }
}

describe("exports carry drawn diagrams (TEMPRA-168)", () => {
  test("a download has an SVG beside each mermaid fence, numbered as figures are", async () => {
    const s = setup();
    await withDiagrams(s);
    const r = fakeRenderer();
    s.deps.renderDiagram = r;
    const out = await tarOf(await s.req("/export"));
    const drawn = [...out.keys()].filter((p) => p.includes(".diagrams/")).sort();
    expect(drawn).toEqual(["notes/a.diagrams/2.svg", "notes/a.diagrams/3.svg"]);
    expect(out.get("notes/a.diagrams/2.svg")).toContain("<title>flowchart LR</title>");
    expect(out.get("notes/a.diagrams/3.svg")).toContain("<title>sequenceDiagram</title>");
    expect(out.get("notes/a.diagrams/2.svg")).toContain('data-theme="light"');
    // Never written into the page.
    expect(out.get("notes/a.md")).not.toContain(".diagrams/");
    expect(r.calls.every((c) => c.theme === "light" && !c.png && c.width === 680)).toBe(true);
    expect(r.calls).toHaveLength(2);
  });

  test("the signed download (Import & export, MCP export) carries them too", async () => {
    const s = setup();
    await withDiagrams(s);
    s.deps.renderDiagram = fakeRenderer();
    const exp = await s.app.request("/owner/demo/-/export", { redirect: "manual" });
    const out = await tarOf(await s.app.request(exp.headers.get("Location") ?? ""));
    expect(out.has("notes/a.diagrams/2.svg")).toBe(true);
  });

  test("render unavailable, or a fence that does not draw: no SVG, and the export succeeds", async () => {
    const s = setup();
    await withDiagrams(s);
    s.deps.renderDiagram = undefined;
    let out = await tarOf(await s.req("/export"));
    expect([...out.keys()].some((p) => p.includes(".diagrams/"))).toBe(false);
    expect(out.has("notes/a.md")).toBe(true);

    s.deps.renderDiagram = fakeRenderer((req) =>
      req.source.startsWith("flowchart")
        ? { error: { message: "render unavailable", line: 0, column: 0 } }
        : { svg: "<svg/>" },
    );
    out = await tarOf(await s.req("/export"));
    expect([...out.keys()].filter((p) => p.includes(".diagrams/"))).toEqual([
      "notes/a.diagrams/3.svg",
    ]);
  });

  test("an import of that bundle makes no attachments of the drawn diagrams", async () => {
    const s = setup();
    await withDiagrams(s);
    s.deps.renderDiagram = fakeRenderer();
    const exp = await s.req("/export");
    const files = readTar(new Uint8Array(await exp.arrayBuffer()));
    expect(files.some((f) => f.path === "notes/a.diagrams/2.svg")).toBe(true);

    const t = setup();
    const r = await t.req("/import", {
      method: "POST",
      body: writeTar(files) as unknown as BodyInit,
      headers: { "Content-Type": "application/x-tar" },
    });
    expect(r.status).toBe(200);
    expect((await r.json()) as { files: number }).toMatchObject({ files: 2 });
    expect((await t.req("/files/notes/a.diagrams/2.svg")).status).toBe(404);
    expect((await t.req("/files/notes/a.md")).status).toBe(200);
  });

  test("a real file where a drawing would go is kept, and nothing is drawn over it", async () => {
    const svg = "<svg>mine</svg>";
    const files = [
      { path: "a.md", text: doc(FLOW) },
      { path: "a.diagrams/1.svg", blob: { hash: "x" } },
    ];
    expect(
      await drawnDiagrams(files, { render: fakeRenderer(() => ({ svg })), ctx: { account: "a" } }),
    ).toEqual([]);
  });

  test("bounded: at most `max` diagrams, a few at a time, and none past the time budget", async () => {
    const body = Array.from({ length: 12 }, () => FLOW).join("\n");
    const files = [{ path: "a.md", text: doc(body) }];
    let inFlight = 0;
    let most = 0;
    const slow = fakeRenderer(async () => {
      most = Math.max(most, ++inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return { svg: "<svg/>" };
    });
    const got = await drawnDiagrams(files, {
      render: slow,
      ctx: { account: "a" },
      max: 10,
      concurrency: 3,
    });
    expect(got.map((d) => d.path)).toEqual(
      Array.from({ length: 10 }, (_, i) => `a.diagrams/${i + 1}.svg`),
    );
    expect(most).toBe(3);

    const never = fakeRenderer(() => new Promise(() => {}));
    expect(
      await drawnDiagrams(files, { render: never, ctx: { account: "a" }, budgetMs: 20 }),
    ).toEqual([]);
  });

  test("the nightly export stays without drawings", async () => {
    const store = new LibraryStore(bunSqlHandle());
    store.apply({ actor: "claude-code/test", request_id: crypto.randomUUID() }, [
      { op: "write", path: "a.md", content: doc(FLOW) },
    ]);
    const bucket = memoryBucket();
    const now = new Date();
    const res = await runMaintenance({
      store,
      bucket,
      libraryId: "lib-x",
      now,
    });
    const key = (res.export as { key: string }).key;
    const tar = readTar(bucket.objects.get(`${key}bundle.tar`) as Uint8Array);
    expect(tar.map((f) => f.path).sort()).toEqual(["a.md"]);
  });
});
