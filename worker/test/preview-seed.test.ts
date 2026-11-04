import { describe, expect, test } from "bun:test";
import {
  copyLibrary,
  DEFAULT_SEED_URL,
  type RemoteLibrary,
  seedChoice,
} from "../scripts/preview-seed";
import { writeTar } from "../src/util/tar";
import { BUNDLES, loadBundle } from "./fixtures";
import { API, ORIGIN, setup } from "./harness";

describe("seedChoice (TEMPRA-109)", () => {
  test("no library: the samples, quietly", () => {
    expect(seedChoice({})).toEqual({
      kind: "samples",
      reason: "no PREVIEW_SEED_LIBRARY is set",
      warn: false,
    });
    expect(seedChoice({ PREVIEW_SEED_LIBRARY: " ", PREVIEW_SEED_TOKEN: "t" }).kind).toBe("samples");
  });

  test("a library without a token: the samples, with a warning", () => {
    const c = seedChoice({ PREVIEW_SEED_LIBRARY: "cl_dixon/tempra-dev", PREVIEW_SEED_TOKEN: "" });
    expect(c.kind).toBe("samples");
    expect(c.kind === "samples" && c.warn).toBe(true);
  });

  test("a library and a token: that library, on production by default", () => {
    expect(
      seedChoice({ PREVIEW_SEED_LIBRARY: "cl_dixon/tempra-dev", PREVIEW_SEED_TOKEN: "secret" }),
    ).toEqual({
      kind: "library",
      source: { url: DEFAULT_SEED_URL, owner: "cl_dixon", slug: "tempra-dev", token: "secret" },
    });
    const local = seedChoice({
      PREVIEW_SEED_LIBRARY: "dev/dev",
      PREVIEW_SEED_TOKEN: "t",
      PREVIEW_SEED_URL: "http://localhost:8803/",
    });
    expect(local.kind === "library" && local.source.url).toBe("http://localhost:8803");
  });

  test("a malformed library or URL fails", () => {
    for (const lib of ["tempra-dev", "a/b/c", "/b", "a/"]) {
      expect(() => seedChoice({ PREVIEW_SEED_LIBRARY: lib, PREVIEW_SEED_TOKEN: "t" })).toThrow(
        "owner/slug",
      );
    }
    const env = { PREVIEW_SEED_LIBRARY: "a/b", PREVIEW_SEED_TOKEN: "t" };
    expect(() => seedChoice({ ...env, PREVIEW_SEED_URL: "not a url" })).toThrow("not a URL");
    expect(() => seedChoice({ ...env, PREVIEW_SEED_URL: "http://app.tempra.dev" })).toThrow(
      "https",
    );
  });
});

describe("copyLibrary: export from one deployment, import into another (TEMPRA-109)", () => {
  /** Two deployments in process, reached by host, as `fetch` would reach them. */
  const world = () => {
    const from = setup();
    const to = setup();
    const hosts: Record<string, ReturnType<typeof setup>> = {
      "source.test": from,
      "preview.test": to,
    };
    const calls: string[] = [];
    const fetch = async (url: string, init?: RequestInit) => {
      const u = new URL(url);
      calls.push(`${init?.method ?? "GET"} ${u.host}${u.pathname}`);
      const s = hosts[u.host];
      if (!s) throw new Error(`no host ${u.host}`);
      return s.anon.request(`${u.pathname}${u.search}`, init);
    };
    const source: RemoteLibrary = {
      url: "https://source.test",
      owner: "owner",
      slug: "demo",
      token: "reader",
    };
    const target: RemoteLibrary = {
      url: "https://preview.test",
      owner: "owner",
      slug: "demo",
      token: "writer",
    };
    return { from, to, fetch, calls, source, target };
  };

  test("carries pages, attachments, generated and verified; not history or comments", async () => {
    const w = world();
    const bundle = BUNDLES[0] as string;
    let r = await w.from.req(`/import?source=fixtures/${bundle}`, {
      method: "POST",
      body: writeTar(loadBundle(bundle)) as unknown as BodyInit,
      headers: { "Content-Type": "application/x-tar" },
    });
    expect(r.status).toBe(200);
    // A page with a later version, a verification, an attachment and a comment thread.
    const md = "---\ntype: Note\ntitle: Seeded\ndescription: One note.\n---\nFirst text.\n";
    r = await w.from.req("/files/notes/seeded.md", { method: "PUT", body: md });
    expect(r.status).toBe(200);
    r = await w.from.req("/files/notes/seeded.md", {
      method: "PUT",
      body: md.replace("First", "Second"),
      headers: { "If-Match": r.headers.get("ETag") ?? "" },
    });
    expect(r.status).toBe(200);
    r = await w.from.req("/verify/notes/seeded.md", { method: "POST", token: "human" });
    expect(r.status).toBe(200);
    r = await w.from.req("/files/notes/data.bin", {
      method: "PUT",
      body: new Uint8Array([0, 1, 2, 3, 250]),
    });
    expect(r.status).toBe(200);
    r = await w.from.app.request(`${API}/comments`, {
      method: "POST",
      headers: { Origin: ORIGIN, "Content-Type": "application/json" },
      body: JSON.stringify({ path: "notes/seeded.md", body: "Is this right?" }),
    });
    expect(r.status).toBe(201);

    expect(await copyLibrary(w.source, w.target, { fetch: w.fetch, log: () => {} })).toBe(
      "imported",
    );
    expect(w.calls).toEqual([
      "GET preview.test/api/v1/libraries/owner/demo/tree",
      "GET source.test/api/v1/libraries/owner/demo/export",
      "POST preview.test/api/v1/libraries/owner/demo/import",
    ]);

    // The same files at head, byte for byte (index.md and log.md are synthesized on each side,
    // log.md from each one's own ledger).
    const files = async (s: ReturnType<typeof setup>) => {
      const { readTar } = await import("../src/util/tar");
      const exp = await s.req("/export");
      return new Map(
        readTar(new Uint8Array(await exp.arrayBuffer()))
          .filter((f) => f.path !== "log.md")
          .map((f) => [f.path, new TextDecoder().decode(f.bytes)]),
      );
    };
    expect(await files(w.to)).toEqual(await files(w.from));

    // Verified stays verified; the import names where it came from.
    const read = await w.to.req("/files/notes/seeded.md");
    const text = await read.text();
    expect(text).toContain("Second text.");
    expect(text).toContain("verified:");
    // What does not come along: earlier versions and comments.
    const history = (await (await w.to.req("/history/notes/seeded.md")).json()) as {
      events: { op: string; meta: { source?: string } | null }[];
    };
    expect(history.events.map((e) => e.op)).toEqual(["import", "verify"]);
    expect(history.events[0]?.meta?.source).toMatch(/^source\.test\/owner\/demo@\d+$/);
    const comments = async (s: ReturnType<typeof setup>) =>
      ((await (await s.req("/comments?path=notes/seeded.md")).json()) as { threads: unknown[] })
        .threads.length;
    expect(await comments(w.from)).toBe(1);
    expect(await comments(w.to)).toBe(0);
  });

  test("a library that already has files is kept, and nothing is exported", async () => {
    const w = world();
    const md = "---\ntype: Note\ntitle: Mine\ndescription: Already here.\n---\nHello.\n";
    expect((await w.to.req("/files/mine.md", { method: "PUT", body: md })).status).toBe(200);
    expect(await copyLibrary(w.source, w.target, { fetch: w.fetch })).toBe("kept");
    expect(w.calls).toEqual(["GET preview.test/api/v1/libraries/owner/demo/tree"]);
  });

  test("a failed export fails the copy and names neither token", async () => {
    const w = world();
    const bad = { ...w.source, token: "not-a-token" };
    const err = await copyLibrary(bad, w.target, { fetch: w.fetch }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("export of owner/demo");
    expect((err as Error).message).not.toContain("not-a-token");
    expect((err as Error).message).not.toContain("writer");
  });

  test("a preview not ready yet is retried, then imported once", async () => {
    const w = world();
    const md = "---\ntype: Note\ntitle: One\ndescription: The one note.\n---\nHello.\n";
    expect((await w.from.req("/files/one.md", { method: "PUT", body: md })).status).toBe(200);
    let failures = 2;
    const flaky = async (url: string, init?: RequestInit) => {
      if (url.endsWith("/tree") && failures-- > 0) return new Response("warming", { status: 503 });
      return w.fetch(url, init);
    };
    const waits: number[] = [];
    const out = await copyLibrary(w.source, w.target, {
      fetch: flaky,
      sleep: async (ms) => {
        waits.push(ms);
      },
      log: () => {},
    });
    expect(waits).toEqual([2000, 4000]);
    expect(out).toBe("imported");
    expect((await w.to.req("/files/one.md")).status).toBe(200);
  });
});
