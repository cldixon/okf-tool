import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  IMAGE_BYTES_PER_CALL,
  imagesService,
  MODEL_BYTES,
  MODEL_EDGE,
  variantKeysFor,
} from "../src/images";
import { INSTRUCTIONS, PDF_RESOURCE_BYTES } from "../src/mcp/server";
import { fakeRenderer } from "../src/render";
import { readTar } from "../src/util/tar";
import { setup } from "./harness";
import { base64, makePng, sample } from "./images";
import { approve, connectApp } from "./oauth-flow";
import { attachFile } from "./upload";

type Text = { type: "text"; text: string };

async function connect(app: ReturnType<typeof setup>["app"], token = "writer") {
  const transport = new StreamableHTTPClientTransport(new URL("http://localhost/mcp"), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
    fetch: async (url, init) => app.request(url.toString(), init as RequestInit),
  });
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(transport);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await client.callTool({ name, arguments: args });
    return { text: (r.content as Text[]).map((c) => c.text).join("\n"), isError: !!r.isError };
  };
  return { client, call };
}

type Call = (
  name: string,
  args?: Record<string, unknown>,
) => Promise<{ text: string; isError: boolean }>;

/** A file goes in as an agent with a shell sends it: prepare_upload, then the PUT. */
async function upload(
  app: ReturnType<typeof setup>["app"],
  call: Call,
  path: string,
  bytes: Uint8Array,
) {
  const put = await attachFile(app, call, path, bytes);
  expect(put.status).toBe(200);
}

const hashOf = (text: string) => /hash: ([0-9a-f]{64})/.exec(text)?.[1] ?? "";

const doc = (title: string, body: string) =>
  `---\ntype: Memo\ntitle: ${title}\ndescription: About ${title}.\nstatus: stable\n---\n${body}`;

describe("MCP server", () => {
  test("tiers: tool lists depend on the token", async () => {
    const { app } = setup();
    const names = async (token: string) =>
      (await (await connect(app, token)).client.listTools()).tools.map((t) => t.name).sort();
    const tier1 = [
      "attach",
      "batch",
      "browse",
      "create_library",
      "delete",
      "edit",
      "grep",
      "move",
      "prepare_upload",
      "read",
      "show",
      "start",
      "transform",
      "write",
    ];
    const tier2 = [
      "comment",
      "comments",
      "diff",
      "export",
      "history",
      "links",
      "log",
      "query",
      "render",
      "revert",
      "search",
      "sources",
      "work",
    ];
    expect(await names("files")).toEqual(tier1);
    expect(await names("writer")).toEqual([...tier1, ...tier2].sort());
    expect(await names("process")).toEqual([...tier1, ...tier2, "verify"].sort());

    const { client } = await connect(app, "files");
    const read = (await client.listTools()).tools.find((t) => t.name === "read");
    expect(Object.keys(read?.inputSchema.properties ?? {})).toEqual([
      "path",
      "image",
      "images",
      "diagrams",
      "figures",
      "library",
    ]);
    const { client: full } = await connect(app, "writer");
    const tier2Tool = (await full.listTools()).tools.find((t) => t.name === "search");
    expect(tier2Tool?.description?.startsWith("Beyond files:")).toBe(true);
    expect(full.getInstructions()).toContain("Call `start` first");
    // Every description is filled in: no `$NAME` a template literal never interpolated.
    const { client: all } = await connect(app, "process");
    for (const t of (await all.listTools()).tools) {
      expect({ tool: t.name, left: t.description?.match(/\$\{?[A-Z_]{3,}/g) ?? [] }).toEqual({
        tool: t.name,
        left: [],
      });
    }
  });

  test("INSTRUCTIONS and SKILL.md tell agents the same media story (TEMPRA-160, TEMPRA-211)", () => {
    const skill = readFileSync(`${import.meta.dir}/../../skills/tempra/SKILL.md`, "utf8");
    for (const term of [
      "Mermaid",
      "`render`",
      "`source_url`",
      "never hotlink",
      "`prepare_upload`",
      "beside the page that uses it",
      "`dir/x.md` uses `dir/x-architecture.png`",
      "the title is the caption",
      ":::figure",
      "`sources`",
      "taken from elsewhere",
      "upload link",
      "upload panel",
      "carries its own `credit` and `licence`",
      "`images: true`",
      "`diagrams: true`",
      "`diagram_invalid`",
      "`diagram_unrendered`",
      "`figure_invalid`",
      "rendered media",
      "never as bytes you type",
      '`origin: "agent"`',
      "you cannot send files to Tempra yourself",
      "`svg` fence",
      "`currentColor`",
      "`svg_invalid`",
      "`svg_unsafe`",
      "`vega-lite` fence",
      "`chart_invalid`",
      "`data.url`",
      "`transform`",
    ]) {
      expect(INSTRUCTIONS.toLowerCase()).toContain(term.toLowerCase());
      expect(skill.toLowerCase()).toContain(term.toLowerCase());
    }
    expect(skill).not.toMatch(/base64|sha256|checksum/i);
  });

  test("results link each page in the app, so agents hand people URLs (TEMPRA-5)", async () => {
    const { app } = setup();
    const { call } = await connect(app);
    const base = "http://localhost/owner/demo/";

    expect((await call("start")).text).toContain(`In the app: ${base} `);

    let r = await call("write", {
      path: "notes/a b.md",
      content: doc("Alpha", "Alpha and omega.\n"),
      note: "a page with a space",
    });
    // The written page's URL, its path encoded, and the library's Activity.
    expect(r.text).toMatch(new RegExp(`hash \\w+ · ${base}notes/a%20b\\.md`));
    expect(r.text).toContain(`Activity: ${base}-/activity`);

    r = await call("read", { path: "notes/a b.md" });
    expect(r.text).toContain(`url: ${base}notes/a%20b.md\n`);
    const seq = Number(/seq: (\d+)/.exec(r.text)?.[1]);
    // A version reads at its own address.
    r = await call("read", { path: "notes/a b.md", at: seq });
    expect(r.text).toContain(`url: ${base}notes/a%20b.md?at=${seq}\n`);

    r = await call("search", { q: "omega" });
    expect(r.text).toContain(`\n  ${base}notes/a%20b.md\n`);
    expect((await call("query", {})).text).toContain(`at its path under ${base}`);

    // A deleted page has no page to link.
    r = await call("read", { path: "notes/a b.md" });
    r = await call("delete", { path: "notes/a b.md", if_match: hashOf(r.text) });
    expect(r.text).not.toContain(`${base}notes/`);
    expect(r.text).toContain(`Activity: ${base}-/activity`);
  });

  test("the file-equivalent workflow", async () => {
    const { app } = setup();
    const { call } = await connect(app);

    expect((await call("start")).text).toContain("The library is empty");

    let r = await call("write", {
      path: "metrics/revenue.md",
      content: doc("Revenue", "Money in. See [orders](/tables/orders.md).\n"),
      note: "first page",
    });
    expect(r.isError).toBe(false);
    expect(r.text).toContain("broken_link");
    r = await call("write", {
      path: "tables/orders.md",
      content: doc("Orders", "One row per order.\n"),
    });
    expect(r.text).toContain("Lint: none.");

    // Writing an existing path without if_match fails with the current hash.
    r = await call("write", { path: "tables/orders.md", content: doc("Orders", "x\n") });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("current_hash: ");

    r = await call("read", { path: "metrics/revenue" });
    expect(r.text).toContain("trust: unverified · stale: no · status: stable · inbound links: 0");
    expect(r.text).toContain("Lint: none.");
    const h = hashOf(r.text);

    r = await call("edit", {
      path: "metrics/revenue.md",
      edits: [{ old: "Money in.", new: "Money received." }],
      if_match: h,
    });
    expect(r.isError).toBe(false);
    r = await call("edit", { path: "metrics/revenue.md", edits: [{ old: "nope", new: "x" }] });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("Current document:");

    expect((await call("grep", { pattern: "received" })).text).toBe(
      "metrics/revenue.md:8: Money received. See [orders](/tables/orders.md).",
    );
    expect((await call("browse", { dir: "metrics" })).text).toBe(
      "In the app: http://localhost/owner/demo/metrics/ (each page at its path under http://localhost/owner/demo/)\n\n# Pages\n\n* [Revenue](revenue.md) - About Revenue.\n",
    );

    r = await call("move", { from: "tables", to: "data/tables", note: "reorganize" });
    expect(r.text).toContain("data/tables/orders.md");
    expect((await call("read", { path: "metrics/revenue.md" })).text).toContain(
      "[orders](/data/tables/orders.md)",
    );

    r = await call("batch", {
      note: "two at once",
      ops: [
        { op: "write", path: "a.md", content: doc("A", "a\n") },
        { op: "write", path: "b.md", content: doc("B", "[a](a.md)\n") },
      ],
    });
    expect(r.text).toContain("Applied a.md");
    const hb = hashOf((await call("read", { path: "b.md" })).text);
    expect((await call("delete", { path: "b.md", if_match: hb })).isError).toBe(false);

    const start = (await call("start")).text;
    expect(start).toContain("Pages: 3 · attachments: 0");
    expect(start).toContain("Health (checked ");
  });

  test("revert is the owner's: a write member's agent is refused and nothing lands", async () => {
    const s = setup();
    const owner = await connect(s.app);
    await owner.call("write", { path: "x.md", content: doc("X", "Alpha.\n") });
    const friend = await s.stranger("friend@example.com");
    await s.accounts.share("lib-1", friend.user.id, "write", "user_1");
    const { secret } = await s.accounts.createToken({
      libraryId: "lib-1",
      actor: "claude-code/friend",
      scope: "write",
      prefix: null,
      expires: null,
      mcpTiers: "all",
      createdBy: friend.user.id,
    });
    const member = await connect(s.app, secret);
    const head = s.store().headSeq();
    // The member's agent writes content, but does not revert (TEMPRA-124).
    const r = await member.call("revert", { path: "x.md", to_seq: 1, note: "undo" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("owner_only");
    expect(s.store().headSeq()).toBe(head);
    expect(
      (await member.call("edit", { path: "x.md", edits: [{ old: "Alpha", new: "Beta" }] })).isError,
    ).toBe(false);
  });

  test("beyond files: search, query, links, log, history, diff, revert, work", async () => {
    const { app } = setup();
    const { call } = await connect(app);
    await call("write", { path: "x.md", content: doc("X", "Alpha beta.\n[y](/y.md)\n") });
    await call("write", { path: "y.md", content: doc("Y", "Gamma.\n") });
    const h = hashOf((await call("read", { path: "x.md" })).text);
    await call("write", {
      path: "x.md",
      content: doc("X", "Alpha delta.\n[y](/y.md)\n"),
      if_match: h,
      note: "delta",
    });

    expect((await call("search", { q: "alpha" })).text).toContain("x.md — X");
    expect((await call("query", {})).text).toContain("2 matching pages");
    expect(JSON.parse((await call("links", { path: "y.md" })).text).inbound[0].path).toBe("x.md");
    const log = (await call("log")).text;
    expect(log.split("\n")[0]).toContain("claude-code/test · delta");
    expect((await call("history", { path: "x.md" })).text).toContain("seq 3");
    const diff = (await call("diff", { path: "x.md" })).text;
    expect(diff).toContain("-Alpha beta.");
    expect(diff).toContain("+Alpha delta.");
    expect((await call("revert", { path: "x.md", to_seq: 1, note: "undo" })).isError).toBe(false);
    expect((await call("read", { path: "x.md" })).text).toContain("Alpha beta.");

    await call("write", {
      path: "old.md",
      content: `---\ntype: Note\nstale_after: 2020-01-01T00:00:00Z\n---\n[gone](/gone.md)\n`,
    });
    const work = (await call("work")).text;
    expect(work).toContain("[stale] old.md");
    expect(work).toContain("[broken_link] old.md");
  });

  test("export and attachments give working short-lived download URLs", async () => {
    const { app } = setup();
    const { call } = await connect(app);
    await call("write", { path: "a.md", content: doc("A", "a\n") });
    const bytes = new Uint8Array([1, 2, 3, 250]);
    await upload(app, call, "refs/data.bin", bytes);

    const read = (await call("read", { path: "refs/data.bin" })).text;
    const fileUrl = /download \(15 minutes\): (\S+)/.exec(read)?.[1] ?? "";
    const got = await app.request(fileUrl);
    expect(got.status).toBe(200);
    expect(new Uint8Array(await got.arrayBuffer())).toEqual(bytes);

    const exp = (await call("export")).text;
    const url = /(http\S+)/.exec(exp)?.[1] ?? "";
    const tar = await app.request(url);
    expect(tar.status).toBe(200);
    const paths = readTar(new Uint8Array(await tar.arrayBuffer()))
      .map((f) => f.path)
      .sort();
    expect(paths).toEqual(["a.md", "refs/data.bin"]);
    // `type` is not a filter: asking for one is refused, not quietly ignored.
    const typed = await call("query", { type: "Note" });
    expect(typed.isError).toBe(true);
    expect(typed.text).toContain("not a filter");
    // An OKF bundle adds each directory's index.md and the log.
    const okf = (await call("export", { format: "okf" })).text;
    expect(okf).toContain("OKF bundle at seq");
    const okfTar = await app.request(/(http\S+)/.exec(okf)?.[1] ?? "");
    expect(okfTar.headers.get("Content-Disposition")).toContain("-okf.tar");
    const okfFiles = readTar(new Uint8Array(await okfTar.arrayBuffer()));
    expect(okfFiles.map((f) => f.path).sort()).toEqual([
      "a.md",
      "index.md",
      "log.md",
      "refs/data.bin",
      "refs/index.md",
    ]);
    const root = new TextDecoder().decode(okfFiles.find((f) => f.path === "index.md")?.bytes);
    expect(root).toContain('okf_version: "0.2"');
    expect(root).toContain("# Concepts");

    // Tampered or foreign links are refused.
    expect((await app.request(`${url.slice(0, -2)}xx`)).status).toBe(403);
    expect((await app.request(url.replace("/dl/lib-1/", "/dl/other/"))).status).toBe(403);
  });

  test("an upload round-trips a quarter-megabyte image byte for byte (TEMPRA-105)", async () => {
    const { app } = setup();
    const { call } = await connect(app);
    const png = makePng(290, 290, { noise: true });
    expect(png.length).toBeGreaterThan(250_000);
    await upload(app, call, "assets/attach-test.png", png);
    const read = (await call("read", { path: "assets/attach-test.png" })).text;
    expect(read).toContain(`size: ${png.length} bytes · media: image/png`);
    expect(read).toContain("dimensions: 290×290 px");
    const url = /download \(15 minutes\): (\S+)/.exec(read)?.[1] ?? "";
    const got = new Uint8Array(await (await app.request(url)).arrayBuffer());
    expect(got.length).toBe(png.length);
    expect(Buffer.from(got).equals(Buffer.from(png))).toBe(true);
    // The same image cut short is refused, never stored.
    const cut = await attachFile(app, call, "assets/attach-cut.png", png.slice(0, 4000));
    expect(cut.status).toBe(400);
    expect(cut.body.code).toBe("bad_image");
  });

  describe("adding files (TEMPRA-158, TEMPRA-203, TEMPRA-204)", () => {
    const bytes = makePng(4, 3);
    const sha = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");

    test("prepare_upload: a curl line whose PUT attaches the file as the caller", async () => {
      const { app, store } = setup();
      const { call } = await connect(app);
      const r = await call("prepare_upload", {
        path: "figures/plot.png",
        note: "Plot from the run.",
      });
      expect(r.isError).toBe(false);
      const line = /^curl -sS -T plot\.png '(\S+)'$/m.exec(r.text);
      expect(line).not.toBeNull();
      const url = line?.[1] ?? "";
      expect(url).toStartWith("http://localhost/ul/lib-1/");
      const put = await app.request(url, { method: "PUT", body: bytes });
      expect(put.status).toBe(200);
      const res = (await put.json()) as { path: string; hash: string; lint: unknown[] };
      expect(res).toMatchObject({ path: "figures/plot.png", hash: sha });
      const read = (await call("read", { path: "figures/plot.png" })).text;
      expect(read).toContain("image/png");
      const last = store().requests({ limit: 1 }).requests[0];
      expect(last).toMatchObject({ actor: "claude-code/test", note: "Plot from the run." });
      expect((await app.request(url, { method: "PUT", body: bytes })).status).toBe(403);
    });

    test("prepare_upload: the person's upload link, and read naming who supplied the file", async () => {
      const s = setup();
      const { call } = await connect(s.app);
      const r = await call("prepare_upload", { path: "figures/photo.png", note: "Their photo." });
      const link = /^(http:\/\/localhost\/owner\/demo\/-\/upload\/\S+)$/m.exec(r.text)?.[1];
      expect(link).toBeDefined();
      expect(r.text).toContain("give them this link");
      const form = new FormData();
      form.set("file", new File([bytes], "photo.png"));
      const sent = await s.app.request(link ?? "", {
        method: "POST",
        body: form,
        headers: { Origin: "http://localhost" },
      });
      expect(sent.status).toBe(200);
      expect((await call("read", { path: "figures/photo.png" })).text).toContain(
        "supplied by: @owner (the person sent the file)",
      );
    });

    test("prepare_upload: read access is refused, and markdown goes through write", async () => {
      const { app } = setup();
      const reader = await connect(app, "reader");
      const r = await reader.call("prepare_upload", { path: "a.png" });
      expect(r.isError).toBe(true);
      expect(r.text).toContain("read_only");
      const { call } = await connect(app);
      expect((await call("prepare_upload", { path: "a.md" })).text).toContain("bad_path");
    });

    test("attach takes no bytes: content_base64 is gone from the schema and refused by name", async () => {
      const { app, store } = setup();
      const { client, call } = await connect(app);
      const { tools } = await client.listTools();
      const attach = tools.find((t) => t.name === "attach");
      const prepare = tools.find((t) => t.name === "prepare_upload");
      const props = (t: typeof attach) => Object.keys(t?.inputSchema.properties ?? {});
      expect(props(attach)).not.toContain("content_base64");
      expect(props(attach)).not.toContain("sha256");
      expect(props(attach)).not.toContain("size");
      expect(props(attach)).toContain("source_url");
      expect(props(prepare)).not.toContain("sha256");
      expect(props(prepare)).not.toContain("size");
      // The advertised schemas exactly (TEMPRA-212): a field added or left behind fails here, so
      // what agents read before anything else cannot drift from what the handlers accept again.
      expect(props(attach).sort()).toEqual(
        [
          "credit",
          "description",
          "if_match",
          "library",
          "licence",
          "note",
          "path",
          "source_url",
        ].sort(),
      );
      expect(props(prepare).sort()).toEqual(
        [
          "credit",
          "description",
          "if_match",
          "library",
          "licence",
          "media",
          "note",
          "origin",
          "path",
        ].sort(),
      );
      expect(prepare?.inputSchema.properties?.origin).toMatchObject({ enum: ["person", "agent"] });
      expect(attach?.inputSchema.required).toEqual(["path"]);
      expect(prepare?.inputSchema.required).toEqual(["path"]);
      for (const t of tools) {
        expect(`${t.description} ${JSON.stringify(t.inputSchema)}`).not.toMatch(
          /base64|sha256|checksum/i,
        );
      }
      expect(INSTRUCTIONS).not.toMatch(/base64|sha256|checksum/i);

      const head = store().headSeq();
      const old = await call("attach", { path: "a.png", content_base64: base64(bytes) });
      expect(old.isError).toBe(true);
      expect(old.text).toContain("base64_removed");
      expect(old.text).toContain("`source_url`");
      expect(old.text).toContain("`prepare_upload`");
      // Even beside a source_url: never ignored.
      const both = await call("attach", {
        path: "a.png",
        source_url: "https://example.com/a.png",
        content_base64: base64(bytes),
      });
      expect(both.text).toContain("base64_removed");
      expect(store().headSeq()).toBe(head);
      expect((await call("read", { path: "a.png" })).isError).toBe(true);
    });

    test("an upload cut short of its Content-Length is refused, and the link stays good", async () => {
      const { app } = setup();
      const { call } = await connect(app);
      const r = await call("prepare_upload", { path: "a.png" });
      const url = /'(http\S+\/ul\/\S+)'$/m.exec(r.text)?.[1] ?? "";
      const short = await app.request(url, {
        method: "PUT",
        body: bytes.slice(0, 10),
        headers: { "Content-Length": String(bytes.length) },
      });
      expect(short.status).toBe(400);
      expect(((await short.json()) as { code: string }).code).toBe("incomplete_upload");
      expect((await call("read", { path: "a.png" })).isError).toBe(true);
      const whole = await app.request(url, { method: "PUT", body: bytes });
      expect(whole.status).toBe(200);
    });
  });

  test("permissions: read-only tokens cannot write; only process tokens verify", async () => {
    const { app } = setup();
    const writer = await connect(app);
    await writer.call("write", { path: "a.md", content: doc("A", "a\n") });

    const reader = await connect(app, "reader");
    const r = await reader.call("write", { path: "b.md", content: doc("B", "b\n") });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("read_only");

    const proc = await connect(app, "process");
    expect((await proc.call("verify", { path: "a.md" })).isError).toBe(false);
    const after = (await writer.call("read", { path: "a.md" })).text;
    expect(after).toContain("trust: machine-confirmed");
    expect(after).toContain("by: process:nightly-verify");
  });

  test("resources list and read pages", async () => {
    const { app } = setup();
    const { client, call } = await connect(app);
    await call("write", { path: "t/a.md", content: doc("A", "a\n") });
    const list = await client.listResources();
    // The panels (the upload panel, TEMPRA-200; the page panel), then the library's files.
    expect(list.resources.map((r) => [r.uri, r.title])).toEqual([
      ["ui://tempra/upload", "Upload a file"],
      ["ui://tempra/page", "Show a page"],
      ["tempra://owner/demo/t/a.md", "A"],
    ]);
    const res = await client.readResource({ uri: "tempra://owner/demo/t/a.md" });
    expect((res.contents[0] as { text: string }).text).toContain("title: A");
  });

  describe("images and attachment bytes (TEMPRA-153, TEMPRA-155)", () => {
    // A valid 1x1 PNG.
    const PNG = Uint8Array.from(
      atob(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
      ),
      (c) => c.charCodeAt(0),
    );
    /** A JPEG of 3000x2000 whose comments pad it past the model's cap. */
    const bigJpeg = () => {
      const parts: number[] = [0xff, 0xd8];
      for (let i = 0; i < 10; i++) {
        parts.push(0xff, 0xfe, 0xff, 0xfd, ...new Array(0xfffb).fill(0x20));
      }
      // SOF0: 8-bit, 2000 high, 3000 wide, one component.
      parts.push(0xff, 0xc0, 0x00, 0x0b, 0x08, 0x07, 0xd0, 0x0b, 0xb8, 0x01, 0x01, 0x11, 0x00);
      // SOS and a byte of image data: attachments are checked on write (TEMPRA-152).
      parts.push(0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00, 0x00);
      parts.push(0xff, 0xd9);
      return new Uint8Array(parts);
    };
    const b64 = (bytes: Uint8Array) => {
      let s = "";
      for (let i = 0; i < bytes.length; i += 0x8000) {
        s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      }
      return btoa(s);
    };
    const SCALED = new Uint8Array([0x52, 0x49, 0x46, 0x46, 4, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);

    /** A stand-in for the IMAGES binding: records each transform and answers a tiny WebP. */
    const fakeImages = (s: ReturnType<typeof setup>) => {
      const calls: { width: number; format: string }[] = [];
      const cache = new Map<string, { bytes: Uint8Array; media: string }>();
      s.deps.images = imagesService({
        blobs: s.blobs,
        cache: {
          get: async (k) => cache.get(k) ?? null,
          put: async (k, bytes, media) => {
            cache.set(k, { bytes, media });
          },
        },
        transformer: {
          input: (stream) => ({
            transform: (t) => ({
              output: async (o) => {
                await new Response(stream).arrayBuffer();
                calls.push({ width: t.width ?? 0, format: o.format });
                return {
                  image: () => new Response(SCALED).body as ReadableStream<Uint8Array>,
                  contentType: () => o.format,
                };
              },
            }),
          }),
        },
      });
      return { calls, cache };
    };

    const content = async (
      client: Awaited<ReturnType<typeof connect>>["client"],
      args: Record<string, unknown>,
    ) =>
      (await client.callTool({ name: "read", arguments: args })).content as (
        | Text
        | { type: "image"; data: string; mimeType: string }
      )[];

    test("read returns a PNG as an image block, with no binding", async () => {
      const s = setup();
      const { client, call } = await connect(s.app);
      await upload(s.app, call, "img/dot.png", PNG);
      const c = await content(client, { path: "img/dot.png" });
      expect(c[0]?.type).toBe("text");
      expect((c[0] as Text).text).toContain("media: image/png");
      expect(c[1]).toEqual({ type: "image", data: b64(PNG), mimeType: "image/png" });
      expect(s.usage.filter((e) => e.kind === "read_image").map((e) => e.bytes)).toEqual([
        PNG.byteLength,
      ]);
      // image: false gives the facts alone.
      const facts = await content(client, { path: "img/dot.png", image: false });
      expect(facts.map((x) => x.type)).toEqual(["text"]);
    });

    test("a large JPEG is scaled for the model, once", async () => {
      const s = setup();
      const { calls, cache } = fakeImages(s);
      const { client, call } = await connect(s.app);
      const jpeg = bigJpeg();
      expect(jpeg.byteLength).toBeGreaterThan(MODEL_BYTES);
      await upload(s.app, call, "img/big.jpg", jpeg);
      for (let i = 0; i < 2; i++) {
        const c = await content(client, { path: "img/big.jpg" });
        const img = c[1] as { type: string; data: string; mimeType: string };
        expect(img.type).toBe("image");
        expect(img.mimeType).toBe("image/webp");
        const decoded = Uint8Array.from(atob(img.data), (ch) => ch.charCodeAt(0));
        expect(decoded).toEqual(SCALED);
        expect(decoded.byteLength).toBeLessThanOrEqual(MODEL_BYTES);
      }
      // Scaled once to the model's edge; the second read came from the cache.
      expect(calls).toEqual([{ width: MODEL_EDGE, format: "image/webp" }]);
      expect([...cache.keys()]).toEqual([
        expect.stringMatching(/^variants\/[0-9a-f]{64}\/1568\.webp$/),
      ]);
    });

    test("without the binding, a large image says it is too large", async () => {
      const s = setup();
      const { client, call } = await connect(s.app);
      await upload(s.app, call, "img/big.jpg", bigJpeg());
      const c = await content(client, { path: "img/big.jpg" });
      expect(c.map((x) => x.type)).toEqual(["text", "text"]);
      expect((c[1] as Text).text).toContain("too large to show");
      expect((c[0] as Text).text).toContain("download (15 minutes): http");
    });

    test("SVG comes back as its text; other files are unchanged", async () => {
      const s = setup();
      const { client, call } = await connect(s.app);
      const svg = '<svg xmlns="http://www.w3.org/2000/svg"><circle r="4"/></svg>';
      await upload(s.app, call, "img/c.svg", new TextEncoder().encode(svg));
      const c = await content(client, { path: "img/c.svg" });
      expect(c.map((x) => x.type)).toEqual(["text", "text"]);
      expect((c[1] as Text).text).toContain("<circle");
      await upload(s.app, call, "refs/data.bin", new Uint8Array([1, 2]));
      const bin = await content(client, { path: "refs/data.bin" });
      expect(bin.map((x) => x.type)).toEqual(["text"]);
    });

    test("a PDF comes as an embedded resource up to a cap; video and audio are facts (TEMPRA-164)", async () => {
      const s = setup();
      const { client, call } = await connect(s.app);
      const pdf = new TextEncoder().encode("%PDF-1.4\n1 0 obj << >> endobj\n%%EOF\n");
      await upload(s.app, call, "docs/paper.pdf", pdf);
      const c = (await client.callTool({ name: "read", arguments: { path: "docs/paper.pdf" } }))
        .content as ({ type: "text"; text: string } | { type: "resource"; resource: unknown })[];
      expect(c[0]?.type).toBe("text");
      expect((c[0] as Text).text).toContain("media: application/pdf");
      expect((c[0] as Text).text).toContain("download (15 minutes): http");
      expect(c[1]).toEqual({
        type: "resource",
        resource: {
          uri: "tempra://owner/demo/docs/paper.pdf",
          mimeType: "application/pdf",
          blob: b64(pdf),
        },
      });
      expect(s.usage.filter((e) => e.kind === "read_pdf").map((e) => e.bytes)).toEqual([
        pdf.byteLength,
      ]);
      // Over the cap: the facts and the link, saying why.
      const big = new Uint8Array(PDF_RESOURCE_BYTES + 1).fill(0x20);
      big.set(new TextEncoder().encode("%PDF-1.4\n"));
      const put = await s.req("/files/docs/big.pdf", {
        method: "PUT",
        headers: { "Content-Type": "application/pdf" },
        body: big,
      });
      expect(put.status).toBeLessThan(300);
      const over = await content(client, { path: "docs/big.pdf" });
      expect(over.map((x) => x.type)).toEqual(["text", "text"]);
      expect((over[1] as Text).text).toContain("not attached here");
      expect(PDF_RESOURCE_BYTES).toBeLessThanOrEqual(IMAGE_BYTES_PER_CALL);
      // A video: its facts, its frame size and the link; no bytes.
      await upload(s.app, call, "clips/demo.webm", sample("clip.webm"));
      const video = await content(client, { path: "clips/demo.webm" });
      expect(video.map((x) => x.type)).toEqual(["text"]);
      expect((video[0] as Text).text).toContain("media: video/webm");
      expect((video[0] as Text).text).toContain("dimensions: 64×36 px");
      // A page's figure lines name what a media figure is.
      await call("write", {
        path: "notes/m.md",
        content:
          "---\ntype: Note\ntitle: M\ndescription: Media.\n---\n![Demo](/clips/demo.webm)\n\n![Paper](/docs/paper.pdf)\n",
      });
      const page = await content(client, { path: "notes/m.md", figures: [1, 2] });
      const head = (page[0] as Text).text;
      expect(head).toContain("Figure 1 · /clips/demo.webm");
      expect(head).toContain("video/webm");
      expect(head).toContain("application/pdf");
      expect(page.map((x) => x.type)).toEqual(["text", "text"]);
      expect((page[1] as Text).text).toContain("a PDF; `read` /docs/paper.pdf");
    });

    test("resources carry an attachment's bytes, up to a cap", async () => {
      const s = setup();
      fakeImages(s);
      const { client, call } = await connect(s.app);
      await upload(s.app, call, "img/big.jpg", bigJpeg());
      await upload(s.app, call, "refs/data.csv", new TextEncoder().encode("a,b\n1,2\n"));
      const big = new Uint8Array(3 * 1024 * 1024).fill(7);
      // Over MCP's request cap, so it goes up over REST.
      const put = await s.req("/files/refs/huge.bin", {
        method: "PUT",
        headers: { "Content-Type": "application/octet-stream" },
        body: big,
      });
      expect(put.status).toBeLessThan(300);

      const list = await client.listResources();
      expect(
        Object.fromEntries(list.resources.map((r) => [r.name, r.mimeType ?? null])),
      ).toMatchObject({ "img/big.jpg": "image/jpeg", "refs/data.csv": "text/csv" });

      const img = (await client.readResource({ uri: "tempra://owner/demo/img/big.jpg" }))
        .contents[0] as { mimeType: string; blob: string };
      expect(img.mimeType).toBe("image/webp");
      expect(Uint8Array.from(atob(img.blob), (ch) => ch.charCodeAt(0))).toEqual(SCALED);

      const csv = (await client.readResource({ uri: "tempra://owner/demo/refs/data.csv" }))
        .contents[0] as { mimeType: string; blob: string };
      expect(csv).toMatchObject({ mimeType: "text/csv", blob: btoa("a,b\n1,2\n") });

      const huge = (await client.readResource({ uri: "tempra://owner/demo/refs/huge.bin" }))
        .contents[0] as { mimeType: string; text: string };
      expect(huge.mimeType).toBe("text/plain");
      expect(huge.text).toContain("Attachment; download: http");
    });

    describe("a page's figures (TEMPRA-154)", () => {
      const FIGS = [
        "# Figures",
        "",
        "Text with an inline ![icon](/img/dot.png) is not a figure.",
        "",
        '![A dot](/img/dot.png "The dot")',
        "",
        "![Remote](https://example.com/x.png)",
        "",
        '![Gone](/img/gone.png "Lost")',
        "",
        '```mermaid title="Flow"',
        "flowchart LR",
        "  A --> B",
        "```",
        "",
      ].join("\n");

      const page = async (s: ReturnType<typeof setup>) => {
        const conn = await connect(s.app);
        await upload(s.app, conn.call, "img/dot.png", PNG);
        const w = await conn.call("write", { path: "t/figs.md", content: doc("Figs", FIGS) });
        expect(w.isError).toBe(false);
        return conn;
      };

      test("read lists them in the header, numbered as the reader numbers them", async () => {
        const s = setup();
        const { client, call } = await page(s);
        const c = await content(client, { path: "t/figs.md" });
        expect(c.map((x) => x.type)).toEqual(["text"]);
        const head = (c[0] as Text).text.split("\n---\n")[0] ?? "";
        expect(head).toContain(
          [
            "Figures:",
            `Figure 1 · /img/dot.png · alt "A dot" · caption "The dot" · 1×1 · ${PNG.byteLength} B · ok`,
            'Figure 2 · https://example.com/x.png · alt "Remote" · external',
            'Figure 3 · /img/gone.png · alt "Gone" · caption "Lost" · missing',
            'Figure 4 · diagram (mermaid, flowchart) · caption "Flow"',
          ].join("\n"),
        );
        // No bytes were read for the list, and none metered.
        expect(s.usage.filter((e) => e.kind === "read_image")).toEqual([]);
        // A page without figures has no block.
        await call("write", { path: "t/plain.md", content: doc("Plain", "Just text.\n") });
        expect((await call("read", { path: "t/plain.md" })).text).not.toContain("Figures:");
      });

      test("images: true returns the one internal image, and says why the rest are not", async () => {
        const s = setup();
        const { client } = await page(s);
        const c = await content(client, { path: "t/figs.md", images: true });
        expect(c.map((x) => x.type)).toEqual(["text", "text", "image", "text"]);
        expect((c[1] as Text).text).toBe("Figure 1: The dot");
        expect(c[2]).toEqual({ type: "image", data: b64(PNG), mimeType: "image/png" });
        expect((c[3] as Text).text).toBe(
          [
            "Not shown:",
            "Figure 2: external images are not fetched (TEMPRA-163)",
            "Figure 3: missing: no attachment at /img/gone.png",
          ].join("\n"),
        );
        expect(s.usage.filter((e) => e.kind === "read_image").map((e) => e.bytes)).toEqual([
          PNG.byteLength,
        ]);
      });

      test("an image with its footnote right after it is a figure (TEMPRA-218)", async () => {
        const s = setup();
        const conn = await connect(s.app);
        await upload(s.app, conn.call, "img/dot.png", PNG);
        const body = [
          '![A dot](/img/dot.png "The dot")[^dot]',
          "",
          "![Also a dot](/img/dot.png) [^dot]",
          "",
          "![Inline dot](/img/dot.png)[^dot] with words is not one.",
          "",
          "[^dot]: Where the dot came from.",
          "",
        ].join("\n");
        const w = await conn.call("write", { path: "t/cited.md", content: doc("Cited", body) });
        expect(w.isError).toBe(false);
        const c = await content(conn.client, { path: "t/cited.md" });
        const head = (c[0] as Text).text.split("\n---\n")[0] ?? "";
        expect(head).toContain(
          [
            "Figures:",
            `Figure 1 · /img/dot.png · alt "A dot" · caption "The dot" · 1×1 · ${PNG.byteLength} B · ok`,
            `Figure 2 · /img/dot.png · alt "Also a dot" · 1×1 · ${PNG.byteLength} B · ok`,
          ].join("\n"),
        );
        expect(head).not.toContain("Figure 3");
        const imgs = await content(conn.client, { path: "t/cited.md", images: true });
        expect(imgs.map((x) => x.type)).toEqual(["text", "text", "image", "text", "image"]);
        expect((imgs[1] as Text).text).toBe("Figure 1: The dot");
        expect(imgs[2]).toEqual({ type: "image", data: b64(PNG), mimeType: "image/png" });
      });

      test("figures: [n] returns only those", async () => {
        const s = setup();
        const { client } = await page(s);
        const one = await content(client, { path: "t/figs.md", figures: [1] });
        expect(one.map((x) => x.type)).toEqual(["text", "text", "image"]);
        const other = await content(client, { path: "t/figs.md", figures: [4, 9] });
        expect(other.map((x) => x.type)).toEqual(["text", "text"]);
        expect((other[1] as Text).text).toBe(
          [
            "Not shown:",
            "Figure 4: not drawn: the render service is unavailable",
            "Figure 9: no such figure (this page has 4)",
          ].join("\n"),
        );
      });

      test("caps: at most 6 images and 2 MB a call", async () => {
        const s = setup();
        const { client, call } = await connect(s.app);
        // Seven images of about 380 KB each: within a model image, past 2 MB by the sixth.
        const lines: string[] = [];
        for (let i = 1; i <= 7; i++) {
          const png = makePng(360, 350 + i, { noise: true });
          expect(png.byteLength).toBeLessThan(MODEL_BYTES);
          const put = await s.req(`/files/img/n${i}.png`, {
            method: "PUT",
            headers: { "Content-Type": "image/png" },
            body: png,
          });
          expect(put.status).toBeLessThan(300);
          lines.push(`![Noise ${i}](/img/n${i}.png)`, "");
        }
        await call("write", { path: "t/many.md", content: doc("Many", lines.join("\n")) });
        const c = await content(client, { path: "t/many.md", images: true });
        const images = c.filter((x) => x.type === "image");
        expect(images.length).toBe(5);
        const total = s.usage
          .filter((e) => e.kind === "read_image")
          .reduce((n, e) => n + (e.bytes ?? 0), 0);
        expect(total).toBeLessThanOrEqual(2 * 1024 * 1024);
        expect((c.at(-1) as Text).text).toBe(
          [
            "Not shown:",
            "Figure 6: over the cap of 2.0 MB of images a call; ask with figures: [6]",
            "Figure 7: over the cap of 6 images a call; ask with figures: [7]",
          ].join("\n"),
        );
        // Asked for by number, a left-out one comes.
        const seventh = await content(client, { path: "t/many.md", figures: [7] });
        expect(seventh.map((x) => x.type)).toEqual(["text", "text", "image"]);
        expect((seventh[1] as Text).text).toBe("Figure 7: Noise 7");
      });

      test("figure lines fill in the size of images stored before it was kept", async () => {
        const s = setup();
        const { call } = await page(s);
        const forget = () =>
          (s.store() as unknown as { sql: { run(q: string, ...a: unknown[]): void } }).sql.run(
            "UPDATE blobs SET width = NULL, height = NULL",
          );
        forget();
        const line1 = async () =>
          (await call("read", { path: "t/figs.md" })).text
            .split("\n")
            .find((l) => l.startsWith("Figure 1 ·"));
        expect(await line1()).toContain("· 1×1 ·");
        // Worked out once and kept: the blob row has it now.
        const rows = (
          s.store() as unknown as { sql: { all(q: string): { width: number }[] } }
        ).sql.all("SELECT width FROM blobs WHERE location = 'r2'");
        expect(rows.map((r) => r.width)).toEqual([1]);
        expect(await line1()).toContain("· 1×1 ·");
      });

      describe("diagrams (TEMPRA-166)", () => {
        const FLOW = "flowchart LR\n  A --> B";
        const drawnPng = makePng(1360, 400);
        const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="680" height="200"></svg>';
        const drawing = () => fakeRenderer(() => ({ svg, png: drawnPng }));
        const ledger = (s: ReturnType<typeof setup>) =>
          (s.store() as unknown as { sql: { all(q: string): { n: number }[] } }).sql.all(
            "SELECT COUNT(*) AS n FROM events",
          )[0]?.n;

        const render = async (
          client: Awaited<ReturnType<typeof connect>>["client"],
          args: Record<string, unknown>,
        ) => {
          const r = await client.callTool({ name: "render", arguments: args });
          return {
            content: r.content as (Text | { type: "image"; data: string; mimeType: string })[],
            isError: !!r.isError,
          };
        };

        test("render draws a source as a PNG, writing nothing", async () => {
          const s = setup();
          const r = drawing();
          s.deps.renderDiagram = r;
          const { client } = await connect(s.app);
          const before = ledger(s);
          const out = await render(client, { source: FLOW });
          expect(out.isError).toBe(false);
          expect(out.content.map((c) => c.type)).toEqual(["text", "image"]);
          expect((out.content[0] as Text).text).toBe(
            "Diagram · mermaid, flowchart · light · 1360×400 px",
          );
          expect(out.content[1]).toEqual({
            type: "image",
            data: b64(drawnPng),
            mimeType: "image/png",
          });
          expect(r.calls).toEqual([{ source: FLOW, theme: "light", width: 680, png: true }]);
          expect(ledger(s)).toBe(before);
          expect(s.usage.filter((e) => e.kind === "read_image").map((e) => e.bytes)).toEqual([
            drawnPng.byteLength,
          ]);
          // A whole fence is drawn as its body; the dark theme is passed on.
          await render(client, { source: `\`\`\`mermaid\n${FLOW}\n\`\`\``, theme: "dark" });
          expect(r.calls[1]).toMatchObject({ source: FLOW, theme: "dark" });
        });

        test("a tall drawing is scaled for the model through Images", async () => {
          const s = setup();
          const { calls } = fakeImages(s);
          s.deps.renderDiagram = fakeRenderer(() => ({ svg, png: makePng(1360, 4000) }));
          const { client } = await connect(s.app);
          const out = await render(client, { source: FLOW });
          expect(out.content[1]).toEqual({
            type: "image",
            data: b64(SCALED),
            mimeType: "image/webp",
          });
          expect(calls).toEqual([{ width: MODEL_EDGE, format: "image/webp" }]);
        });

        test("render returns Pele's error with its line and column", async () => {
          const s = setup();
          s.deps.renderDiagram = fakeRenderer(() => ({
            error: { message: "Expected an arrow", line: 2, column: 5 },
          }));
          const { client } = await connect(s.app);
          const out = await render(client, { source: "flowchart LR\n  A -> B" });
          expect(out.isError).toBe(false);
          expect(out.content.map((c) => c.type)).toEqual(["text"]);
          expect((out.content[0] as Text).text).toContain(
            "Pele could not draw it: Expected an arrow (line 2, column 5)\n  2 |   A -> B",
          );
        });

        test("a :::figure group's images count one each before a diagram", async () => {
          const s = setup();
          const r = drawing();
          s.deps.renderDiagram = r;
          const { client, call } = await page(s);
          const body = [
            ":::figure[Two dots]",
            '![A](/img/dot.png "One")',
            '![B](/img/dot.png "Two")',
            ":::",
            "",
            "```mermaid",
            FLOW,
            "```",
            "",
          ].join("\n");
          const w = await call("write", { path: "t/group.md", content: doc("Group", body) });
          expect(w.isError).toBe(false);
          const out = await render(client, { path: "t/group.md", figure: 3 });
          expect((out.content[0] as Text).text).toStartWith("Figure 3 of /t/group.md · mermaid");
          const c = await content(client, { path: "t/group.md", figures: [3] });
          expect((c[1] as Text).text).toBe("Figure 3: diagram (flowchart)");
          const d = await content(client, { path: "t/group.md", diagrams: true });
          expect(d.map((x) => x.type)).toEqual(["text", "text", "image"]);
          expect((d[1] as Text).text).toBe("Figure 3: diagram (flowchart)");
        });

        test("render by path and figure number", async () => {
          const s = setup();
          const r = drawing();
          s.deps.renderDiagram = r;
          const { client } = await page(s);
          const out = await render(client, { path: "t/figs.md", figure: 4 });
          expect((out.content[0] as Text).text).toBe(
            'Figure 4 of /t/figs.md ("Flow") · mermaid, flowchart · light · 1360×400 px',
          );
          expect(r.calls[0]?.source).toBe(FLOW);
          const image = await render(client, { path: "t/figs.md", figure: 1 });
          expect(image.isError).toBe(true);
          expect((image.content[0] as Text).text).toContain("is an image, not a diagram");
          const none = await render(client, { path: "t/figs.md", figure: 9 });
          expect((none.content[0] as Text).text).toContain("has no figure 9 (it has 4)");
          const both = await render(client, { source: FLOW, path: "t/figs.md", figure: 4 });
          expect(both.isError).toBe(true);
        });

        test("without a PNG it returns the SVG as text; without the service, says so", async () => {
          const s = setup();
          s.deps.renderDiagram = fakeRenderer(() => ({
            svg,
            error: {
              message: "PNG not drawn: Browser Rendering is not enabled",
              line: 0,
              column: 0,
            },
          }));
          const { client } = await connect(s.app);
          const out = await render(client, { source: FLOW });
          expect(out.isError).toBe(false);
          expect(out.content.map((c) => c.type)).toEqual(["text"]);
          expect((out.content[0] as Text).text).toBe(
            `Diagram · mermaid, flowchart · light\nDrawn, but the PNG could not be made (PNG not drawn: Browser Rendering is not enabled); the SVG follows as text (${svg.length} B).\n${svg}`,
          );

          s.deps.renderDiagram = undefined;
          const off = await render(client, { source: FLOW });
          expect(off.isError).toBe(true);
          expect((off.content[0] as Text).text).toContain(
            "Not drawn: the render service is unavailable.",
          );
        });

        test("renders are capped per account", async () => {
          const s = setup();
          s.deps.renderDiagram = drawing();
          const keys: string[] = [];
          s.deps.rateLimit = async (kind, key) => {
            if (kind === "render") keys.push(key);
            return kind !== "render";
          };
          const { client } = await connect(s.app);
          const out = await render(client, { source: FLOW });
          expect(out.isError).toBe(true);
          expect((out.content[0] as Text).text).toContain(
            "over the limit of 60 renders a minute for this account",
          );
          expect(keys).toEqual(["render:owner"]);
        });

        test("read with diagrams: true draws them under their figure lines", async () => {
          const s = setup();
          s.deps.renderDiagram = drawing();
          const { client } = await page(s);
          const c = await content(client, { path: "t/figs.md", diagrams: true });
          expect(c.map((x) => x.type)).toEqual(["text", "text", "image"]);
          expect((c[1] as Text).text).toBe("Figure 4: Flow");
          expect(c[2]).toEqual({ type: "image", data: b64(drawnPng), mimeType: "image/png" });
          // With images too, both kinds in figure order.
          const all = await content(client, { path: "t/figs.md", images: true, diagrams: true });
          expect(all.map((x) => (x.type === "text" ? x.text.split("\n")[0] : x.type))).toEqual([
            "path: t/figs.md",
            "Figure 1: The dot",
            "image",
            "Figure 4: Flow",
            "image",
            "Not shown:",
          ]);
          // One that does not draw is listed with Pele's error.
          s.deps.renderDiagram = fakeRenderer(() => ({
            error: { message: "Expected an arrow", line: 2, column: 5 },
          }));
          const bad = await content(client, { path: "t/figs.md", figures: [4] });
          expect((bad.at(-1) as Text).text).toBe(
            "Not shown:\nFigure 4: Pele could not draw it: Expected an arrow (line 2, column 5)\n  2 |   A --> B",
          );
        });

        test("diagrams share the per-call caps with images", async () => {
          const s = setup();
          // A drawing of about 380 KB: within a model image, past 2 MB after five images.
          const big = makePng(360, 352, { noise: true });
          s.deps.renderDiagram = fakeRenderer(() => ({ svg, png: big }));
          const { client, call } = await connect(s.app);
          const lines: string[] = [];
          for (let i = 1; i <= 5; i++) {
            const put = await s.req(`/files/img/n${i}.png`, {
              method: "PUT",
              headers: { "Content-Type": "image/png" },
              body: makePng(360, 350 + i, { noise: true }),
            });
            expect(put.status).toBeLessThan(300);
            lines.push(`![Noise ${i}](/img/n${i}.png)`, "");
          }
          lines.push("```mermaid", FLOW, "```", "", "![Dot](/img/n1.png)", "");
          await call("write", { path: "t/mixed.md", content: doc("Mixed", lines.join("\n")) });
          const c = await content(client, { path: "t/mixed.md", images: true, diagrams: true });
          expect(c.filter((x) => x.type === "image").length).toBe(5);
          expect((c.at(-1) as Text).text).toBe(
            [
              "Not shown:",
              "Figure 6: over the cap of 2.0 MB of images a call; ask with figures: [6]",
              "Figure 7: over the cap of 6 images a call; ask with figures: [7]",
            ].join("\n"),
          );
          const sixth = await content(client, { path: "t/mixed.md", figures: [6] });
          expect(sixth.map((x) => x.type)).toEqual(["text", "text", "image"]);
          expect((sixth[1] as Text).text).toBe("Figure 6: diagram (flowchart)");
        });
      });
    });

    test("the sweep's variant keys cover every edge and format of a blob", () => {
      const keys = variantKeysFor(["blobs/abc", "exports/x"]);
      expect(keys).toContain("variants/abc/1568.webp");
      expect(keys.every((k) => k.startsWith("variants/abc/"))).toBe(true);
    });
  });

  test("rejects requests without a valid token", async () => {
    const { app } = setup();
    const r = await app.request("/mcp", { method: "POST", body: "{}" });
    expect(r.status).toBe(401);
  });

  describe("create_library (TEMPRA-100)", () => {
    /** A read-and-write connection to all libraries that may create them. */
    const creator = { ...approve, libraries: "all", library: "", create_libraries: "on" };

    test("creates a library the person owns, then writes in it as their agent", async () => {
      const s = setup();
      const { call } = await connectApp(s.app, creator);
      const made = await call("create_library", {
        slug: "recipes",
        title: "Recipes",
        description: "What we cook.",
      });
      expect(made.isError).toBe(false);
      expect(made.text).toContain("Created library owner/recipes, owned by @owner");
      // It answers like start for the new library.
      expect(made.text).toContain("# Library owner/recipes (seq 0)");
      expect(made.text).toContain("Title: Recipes");
      expect(made.text).toContain("Description: What we cook.");
      expect(made.text).toContain("The library is empty");
      expect((await s.accounts.library("owner", "recipes"))?.ownerId).toBe("user_1");

      const w = await call("write", {
        library: "owner/recipes",
        path: "soup.md",
        content: doc("Soup", "Hot.\n"),
        note: "First recipe",
      });
      expect(w.isError).toBe(false);
      expect((await call("start", { library: "owner/recipes" })).text).toContain("Title: Recipes");
      // The ledger's first event is the person's agent, as with any other write.
      const log = (await (
        await s.app.request("/api/v1/libraries/owner/recipes/requests")
      ).json()) as { requests: { actor: string; by: { person: string; agent?: string } }[] };
      expect(log.requests).toHaveLength(1);
      expect(log.requests[0]?.actor).toBe("claude-ai/connector");
      expect(log.requests[0]?.by.person).toBe("user_1");
      expect(log.requests[0]?.by.agent).toMatch(/^agt_/);
      const agents = (await (
        await s.app.request("/api/v1/libraries/owner/recipes/agents")
      ).json()) as { contributors: { person: string; agent: { name: string } }[] };
      expect(agents.contributors.map((c) => `${c.agent.name} for ${c.person}`)).toEqual([
        "Claude for owner",
      ]);
      // Counted as a write against the person's account, like any write.
      expect(s.usage.filter((e) => e.kind === "write").map((e) => e.account)).toEqual([
        "owner",
        "owner",
      ]);
      // The app lists it, with what the agent said it is for.
      const list = (await (await s.app.request("/api/v1/libraries")).json()) as {
        libraries: { slug: string; role: string }[];
      };
      expect(list.libraries.find((l) => l.slug === "recipes")?.role).toBe("owner");
    });

    test("refused for a read connection, without the choice, and for a bearer token", async () => {
      const s = setup();
      const read = await connectApp(
        s.app,
        { ...creator, access: "read" },
        { scope: "tempra:read" },
      );
      expect(read.flow.html).not.toContain("create_libraries");
      const r1 = await read.call("create_library", { slug: "x" });
      expect(r1.isError).toBe(true);
      expect(r1.text).toContain("create_not_allowed");
      expect(r1.text).toContain("read access");

      const { create_libraries: _, ...without } = creator;
      const plain = await connectApp(s.app, without);
      const r2 = await plain.call("create_library", { slug: "x" });
      expect(r2.text).toContain("create_not_allowed");
      expect(r2.text).toContain("reconnect");

      const files = await connectApp(s.app, { ...without, tiers: "files" });
      expect((await files.call("create_library", { slug: "x" })).text).toContain(
        "create_not_allowed",
      );

      const token = await connect(s.app, "writer");
      const r3 = await token.call("create_library", { slug: "x" });
      expect(r3.text).toContain("create_not_allowed");
      expect(r3.text).toContain("reaches one library");
      expect(await s.accounts.library("owner", "x")).toBeNull();
    });

    test("the library limit, a taken slug and bad slugs are refused", async () => {
      const s = setup();
      s.db.run(`UPDATE users SET limits = '{"libraries": 2}' WHERE id = 'user_1'`);
      const { call } = await connectApp(s.app, creator);
      const taken = await call("create_library", { slug: "demo" });
      expect(taken.text).toContain("Error 409 slug_taken");
      for (const slug of ["Bad Slug", "owner/x", "stranger/x", "../x", "-x", "x/", ""]) {
        const bad = await call("create_library", { slug });
        expect(bad.isError).toBe(true);
        expect(bad.text).toContain("bad_slug");
      }
      const line = await call("create_library", { slug: "ok", title: "One\n## Two" });
      expect(line.text).toContain("bad_title");
      const long = await call("create_library", { slug: "ok", description: "x".repeat(301) });
      expect(long.text).toContain("bad_description");
      expect((await call("create_library", { slug: "second" })).isError).toBe(false);
      const over = await call("create_library", { slug: "third" });
      expect(over.text).toContain("Error 403 library_limit");
      expect(over.text).toContain("limit of 2 libraries");
      expect((await s.accounts.libraries("user_1")).map((l) => l.slug).sort()).toEqual([
        "demo",
        "second",
      ]);
    });
  });
});
