import { describe, expect, test } from "bun:test";
import { parseConcept } from "../src/okf/concept";
import { readTar, writeTar } from "../src/util/tar";
import { compareBundle } from "./compare";
import { BUNDLES, loadBundle } from "./fixtures";
import { setup } from "./harness";

const doc = (body: string, extra = "") => `---\ntype: Note\n${extra}---\n${body}`;

describe("auth", () => {
  test("requires a bearer token for the right library", async () => {
    const { req, app } = setup();
    expect((await req("/tree", { token: "" })).status).toBe(401);
    expect((await req("/tree", { token: "nope" })).status).toBe(401);
    const other = await app.request("/api/v1/libraries/other/tree", {
      headers: { Authorization: "Bearer writer" },
    });
    expect(other.status).toBe(403);
    expect((await req("/tree")).status).toBe(200);
  });

  test("scope and prefix limit writes", async () => {
    const { req } = setup();
    const put = (path: string, token: string) =>
      req(`/files/${path}`, {
        method: "PUT",
        body: doc("x"),
        token,
        headers: { "Content-Type": "text/markdown" },
      });
    expect((await put("a.md", "reader")).status).toBe(403);
    expect((await put("a.md", "scoped")).status).toBe(403);
    expect((await put("notes/a.md", "scoped")).status).toBe(200);
  });
});

describe("files", () => {
  test("PUT, GET with ETag, conditional replace, PATCH, move, DELETE", async () => {
    const { req } = setup();
    let r = await req("/files/notes/a.md", {
      method: "PUT",
      body: doc("Hello [b](b.md)\n"),
      headers: { "If-None-Match": "*", "X-Note": "first write" },
    });
    expect(r.status).toBe(200);
    const created = (await r.json()) as { hash: string; seq: number; lint: { code: string }[] };
    expect(created.seq).toBe(1);
    expect(created.lint.map((l) => l.code)).toEqual(["broken_link"]);

    r = await req("/files/notes/a");
    expect(r.headers.get("ETag")).toBe(`"${created.hash}"`);
    expect(r.headers.get("Content-Type")).toContain("text/markdown");
    const md = await r.text();
    expect(parseConcept(md).generated?.by).toBe("claude-code/test");

    r = await req("/files/notes/a.md", { headers: { Accept: "application/json" } });
    const view = (await r.json()) as { frontmatter: { type: string }; trust_tier: string };
    expect(view.frontmatter.type).toBe("Note");
    expect(view.trust_tier).toBe("unverified");

    // Replace needs the right If-Match.
    r = await req("/files/notes/a.md", { method: "PUT", body: doc("v2") });
    expect(r.status).toBe(412);
    expect(((await r.json()) as { current_hash: string }).current_hash).toBe(created.hash);
    r = await req("/files/notes/a.md", {
      method: "PUT",
      body: JSON.stringify({ frontmatter: { type: "Note", title: "A" }, body: "v2\n" }),
      headers: { "Content-Type": "application/json", "If-Match": `"${created.hash}"` },
    });
    expect(r.status).toBe(200);

    r = await req("/files/notes/a.md", {
      method: "PATCH",
      body: JSON.stringify({ edits: [{ old: "v2", new: "v3" }], note: "tweak" }),
    });
    expect(r.status).toBe(200);
    r = await req("/files/notes/a.md", {
      method: "PATCH",
      body: JSON.stringify({ edits: [{ old: "zzz", new: "" }] }),
    });
    expect(r.status).toBe(409);

    r = await req("/files/notes/a.md/move", {
      method: "POST",
      body: JSON.stringify({ to: "notes/c.md" }),
    });
    expect(r.status).toBe(200);
    expect((await req("/files/notes/a.md")).status).toBe(404);
    const moved = (await (
      await req("/files/notes/c.md", { headers: { Accept: "application/json" } })
    ).json()) as {
      hash: string;
      body: string;
    };
    expect(moved.body).toBe("v3\n");

    expect((await req("/files/notes/c.md", { method: "DELETE" })).status).toBe(428);
    r = await req("/files/notes/c.md", { method: "DELETE", headers: { "If-Match": moved.hash } });
    expect(r.status).toBe(200);

    const hist = (await (await req("/history/notes/c.md")).json()) as { events: { op: string }[] };
    expect(hist.events.map((e) => e.op)).toEqual(["put", "put", "put", "move", "delete"]);
    const reqs = (await (await req("/requests")).json()) as { requests: { note: string | null }[] };
    expect(reqs.requests.map((x) => x.note)).toEqual([null, null, "tweak", null, "first write"]);
  });

  test("index.md and log.md are synthesized and read-only", async () => {
    const { req } = setup();
    await req("/files/t/x.md", {
      method: "PUT",
      body: doc("x", "title: X\ndescription: The x.\n"),
    });
    const idx = await (await req("/files/t/index.md")).text();
    expect(idx).toBe("# Concepts\n\n* [X](x.md) - The x.\n");
    const root = await (await req("/files/index.md")).text();
    expect(root).toContain('okf_version: "0.2"');
    const log = await (await req("/files/log.md")).text();
    expect(log).toContain("* **Creation** by `claude-code/test`: [t/x.md](/t/x.md)");
    expect((await req("/files/t/index.md", { method: "PUT", body: "x" })).status).toBe(405);
  });

  test("attachments go through the Worker and read back byte-identical", async () => {
    const { req, blobs } = setup();
    const bytes = new Uint8Array([0, 1, 2, 3, 250]);
    let r = await req("/files/refs/data.bin", { method: "PUT", body: bytes });
    expect(r.status).toBe(200);
    const { hash } = (await r.json()) as { hash: string };
    expect(blobs.map.has(hash)).toBe(true);
    r = await req("/files/refs/data.bin");
    expect(r.headers.get("Content-Disposition")).toContain("attachment");
    expect(new Uint8Array(await r.arrayBuffer())).toEqual(bytes);
  });
});

describe("queries and revert", () => {
  test("tree, concepts, search, grep, links, events, revert", async () => {
    const { req } = setup();
    const batch = await req("/batch", {
      method: "POST",
      body: JSON.stringify({
        note: "seed",
        ops: [
          {
            op: "write",
            path: "m/rev.md",
            content: doc("Revenue [cost](/m/cost.md)\n", "tags: [finance]\n"),
          },
          { op: "write", path: "m/cost.md", content: doc("Cost\n") },
        ],
      }),
    });
    expect(batch.status).toBe(200);
    const b = (await batch.json()) as { request_id: string; results: unknown[] };
    expect(b.results.length).toBe(2);

    const tree = (await (await req("/tree?prefix=m")).json()) as { entries: { path: string }[] };
    expect(tree.entries.map((e) => e.path)).toEqual(["m/cost.md", "m/rev.md"]);
    const q = (await (await req("/concepts?tag=finance")).json()) as { items: { path: string }[] };
    expect(q.items.map((e) => e.path)).toEqual(["m/rev.md"]);
    const s = (await (await req("/search?q=revenue")).json()) as { results: { path: string }[] };
    expect(s.results.map((e) => e.path)).toEqual(["m/rev.md"]);
    const g = (await (await req("/grep?pattern=Cost")).json()) as {
      matches: { path: string; line: number }[];
    };
    expect(g.matches).toEqual([{ path: "m/cost.md", line: 5, text: "Cost" }] as never);
    const l = (await (await req("/links/m/cost.md")).json()) as { inbound: { path: string }[] };
    expect(l.inbound.map((x) => x.path)).toEqual(["m/rev.md"]);
    const ev = (await (await req("/events?since=1")).json()) as { events: { seq: number }[] };
    expect(ev.events.map((e) => e.seq)).toEqual([2]);

    const rv = await req("/revert", {
      method: "POST",
      body: JSON.stringify({ request_id: b.request_id }),
    });
    expect(rv.status).toBe(200);
    const after = (await (await req("/tree")).json()) as { entries: unknown[] };
    expect(after.entries).toEqual([]);
    // History is kept: reading as of seq 2 still works.
    expect((await req("/files/m/rev.md?at=2")).status).toBe(200);
    expect((await req("/files/m/rev.md?at=abc")).status).toBe(400);
  });
});

describe("tar", () => {
  test("round-trips files, including long paths", () => {
    const enc = new TextEncoder();
    const long = `${"deep/".repeat(30)}file.md`;
    const files = [
      { path: "a.md", bytes: enc.encode("hello") },
      { path: long, bytes: enc.encode("x".repeat(1000)) },
      { path: "empty.txt", bytes: new Uint8Array() },
    ];
    expect(readTar(writeTar(files))).toEqual(files);
  });
});

describe("import and export round-trip the sample bundles (through the API)", () => {
  for (const bundle of BUNDLES) {
    test(bundle, async () => {
      const { req } = setup();
      const original = loadBundle(bundle);
      const r = await req(`/import?source=fixtures/${bundle}`, {
        method: "POST",
        body: writeTar(original) as unknown as BodyInit,
        headers: { "Content-Type": "application/x-tar" },
      });
      expect(r.status).toBe(200);
      const res = (await r.json()) as { files: number };
      expect(res.files).toBe(original.filter((f) => !/(^|\/)(index|log)\.md$/.test(f.path)).length);

      const exp = await req("/export");
      expect(exp.status).toBe(200);
      const out = new Map(
        readTar(new Uint8Array(await exp.arrayBuffer())).map((f) => [f.path, f.bytes]),
      );
      expect(compareBundle(original, out)).toEqual([]);
      // index.md and log.md are synthesized at every level the original had them.
      for (const f of original)
        if (/(^|\/)index\.md$/.test(f.path)) expect(out.has(f.path)).toBe(true);
    });
  }
});
