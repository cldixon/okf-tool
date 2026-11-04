import { describe, expect, test } from "bun:test";
import { readTar, writeTar } from "../src/util/tar";
import { API, ORIGIN, setup } from "./harness";

type S = ReturnType<typeof setup>;
const LIB = "/owner/demo";

async function page(s: S, path: string) {
  const r = await s.app.request(path);
  return { status: r.status, html: await r.text(), headers: r.headers };
}

/** JSON to the API as the signed-in owner, from this site's pages unless `origin` says. */
function post(s: S, path: string, body: unknown, origin = ORIGIN) {
  return s.app.request(path, {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function put(s: S, path: string, content: string) {
  const r = await s.req(`/files/${path}`, {
    method: "PUT",
    headers: { "Content-Type": "text/markdown" },
    body: content,
  });
  expect(r.status).toBeLessThan(300);
}

describe("verify, work queue, import and export (Phase 3, slice 3)", () => {
  test("verify the current version, from the app", async () => {
    const s = setup();
    await put(s, "a.md", "---\ntype: Note\n---\nChecked content.\n");
    const page = async () =>
      (await (
        await s.app.request(`${API}/files/a.md`, { headers: { Accept: "application/json" } })
      ).json()) as {
        trust_tier: string;
        hash: string;
        frontmatter: { verified?: { by: string }[] };
      };
    expect((await page()).trust_tier).toBe("unverified");

    const forgedApi = await s.app.request(`${API}/verify/a.md`, {
      method: "POST",
      headers: { Origin: "https://evil.example" },
    });
    expect(forgedApi.status).toBe(403);

    // The app verifies through the API, with the note in X-Note.
    const done = await s.app.request(`${API}/verify/a.md`, {
      method: "POST",
      headers: { Origin: ORIGIN, "X-Note": "read it" },
    });
    expect(done.status).toBe(200);
    const after = await page();
    expect(after.trust_tier).toBe("human-reviewed");
    expect(after.frontmatter.verified?.at(-1)?.by).toBe("human:owner");
    const requests = (await (await s.app.request(`${API}/requests?limit=1`)).json()) as {
      requests: { note: string; events: { op: string }[] }[];
    };
    expect(requests.requests[0]).toMatchObject({ note: "read it", events: [{ op: "verify" }] });

    // The next edit lapses it.
    await s.req("/files/a.md", {
      method: "PUT",
      headers: { "Content-Type": "text/markdown", "If-Match": `"${after.hash}"` },
      body: "---\ntype: Note\n---\nChanged.\n",
    });
    expect((await page()).trust_tier).toBe("unverified");
  });

  test("the work queue page lists and filters items", async () => {
    const s = setup();
    await put(
      s,
      "a.md",
      "---\ntype: Memo\ndescription: A memo.\nstatus: draft\n---\nSee [gone](/gone.md).\n",
    );
    await put(s, "b.md", "---\ntype: Note\n---\nx\n");
    type Work = { items: { kind: string; path: string; detail: string }[] };
    const work = async (q = "") => (await (await s.app.request(`${API}/work${q}`)).json()) as Work;
    const all = await work();
    expect(all.items).toContainEqual(
      expect.objectContaining({ kind: "broken_link", detail: expect.stringContaining("/gone.md") }),
    );
    expect(all.items.map((i) => i.path)).toContain("b.md");
    const lint = await work("?kind=lint");
    expect(lint.items.map((i) => i.path)).toContain("b.md");
    expect(lint.items.every((i) => i.kind === "lint")).toBe(true);
    // One file's items, as a page's view asks for them.
    const one = await work("?path=a.md");
    expect(new Set(one.items.map((i) => i.path))).toEqual(new Set(["a.md"]));
    expect((await work("?path=nothing.md")).items).toEqual([]);
    await put(s, "gone.md", "---\ntype: Note\n---\nhere\n");
    expect((await work("?kind=broken_link")).items).toEqual([]);
  });

  test("export downloads the bundle; import adds files as one request by the human", async () => {
    const s = setup();
    await put(s, "a.md", "---\ntype: Note\n---\nA\n");
    const exp = await s.app.request(`${LIB}/-/export`, { redirect: "manual" });
    expect(exp.status).toBe(302);
    const tar = await s.app.request(exp.headers.get("Location") ?? "");
    expect(tar.headers.get("Content-Disposition")).toContain("demo");
    const paths = readTar(new Uint8Array(await tar.arrayBuffer())).map((f) => f.path);
    expect(paths).toContain("a.md");

    const enc = new TextEncoder();
    const bundle = writeTar([
      { path: "pack/notes/x.md", bytes: enc.encode("---\ntype: Note\n---\nX\n") },
      { path: "pack/notes/y.md", bytes: enc.encode("no frontmatter, lint me\n") },
      { path: "pack/index.md", bytes: enc.encode("# ignored\n") },
    ]);
    const upload = (body: Uint8Array, origin = ORIGIN) =>
      s.app.request(`${API}/import?strip=1&source=pack.tar`, {
        method: "POST",
        headers: {
          Origin: origin,
          "Content-Type": "application/x-tar",
          "X-Note": "bring in the pack",
        },
        body,
      });
    expect((await upload(bundle, "https://evil.example")).status).toBe(403);
    const r = await upload(bundle);
    expect(r.status).toBe(200);
    const result = (await r.json()) as { files: number; warnings: { path: string }[] };
    expect(result.files).toBe(2);
    expect(result.warnings.map((w) => w.path)).toEqual(["notes/y.md"]);
    expect(s.store().read("notes/x.md").kind).toBe("page");
    const ledger = await (await s.app.request(`${API}/requests?limit=1`)).text();
    expect(ledger).toContain("bring in the pack");
    expect(ledger).toContain("human:owner");

    const bad = await upload(enc.encode("not a tar at all"));
    expect(bad.status).toBe(400);
  });
});

describe("libraries and tokens", () => {
  test("create a library from the list page", async () => {
    const s = setup();
    expect(
      (await post(s, "/api/v1/libraries", { slug: "team-notes" }, "https://evil.example")).status,
    ).toBe(403);
    const r = await post(s, "/api/v1/libraries", { slug: "team-notes" });
    expect(r.status).toBe(201);
    expect(await r.json()).toMatchObject({ owner: "owner", slug: "team-notes" });
    expect((await s.accounts.libraries("user_1")).map((l) => l.slug)).toContain("team-notes");
    expect((await page(s, "/owner/team-notes/")).status).toBe(200);
    const dup = await post(s, "/api/v1/libraries", { slug: "team-notes" });
    expect(dup.status).toBe(409);
    expect(await dup.text()).toContain("You already have a library named team-notes.");
  });

  test("mint a token in the UI, use it, and revoke it", async () => {
    const s = setup();
    const form = (actor: string) => ({
      library: "demo",
      actor,
      scope: "write",
      prefix: null,
      expires: null,
      mcp_tiers: "all",
    });
    const bad = await post(s, "/api/v1/tokens", form("human:someone-else"));
    expect(bad.status).toBe(403);
    expect(await bad.text()).toContain("your own actor, human:owner");
    const forged = await post(s, "/api/v1/tokens", form("claude-code/x"), "https://evil.example");
    expect(forged.status).toBe(403);

    const created = await post(s, "/api/v1/tokens", form("claude-code/laptop"));
    expect(created.status).toBe(201);
    const { id, secret } = (await created.json()) as { id: string; secret: string };
    expect(secret).toStartWith("tempra_");

    const write = await s.req("/files/t.md", {
      method: "PUT",
      token: secret,
      headers: { "Content-Type": "text/markdown" },
      body: "---\ntype: Note\n---\nvia minted token\n",
    });
    expect(write.status).toBeLessThan(300);
    expect((await page(s, "/agents")).status).toBe(200);
    const list = (await (await s.app.request("/api/v1/tokens")).json()) as {
      tokens: { id: string; actor: string; created_by: string; revoked: unknown }[];
    };
    expect(list.tokens.find((t) => t.id === id)).toMatchObject({
      actor: "claude-code/laptop",
      created_by: "owner@example.com",
    });

    const revoke = (origin: string) =>
      s.app.request(`/api/v1/tokens/${id}`, { method: "DELETE", headers: { Origin: origin } });
    expect((await revoke("https://evil.example")).status).toBe(403);
    expect((await revoke(ORIGIN)).status).toBe(204);
    expect((await s.req("/files/t.md", { token: secret })).status).toBe(401);

    // Your own human: actor is allowed from the app.
    expect((await post(s, "/api/v1/tokens", form("human:owner"))).status).toBe(201);
  });

  test("REST management routes need a human: token", async () => {
    const s = setup();
    const call = (path: string, init: RequestInit & { token?: string } = {}) => {
      const headers = new Headers(init.headers);
      headers.set("Authorization", `Bearer ${init.token ?? "human"}`);
      if (init.body) headers.set("Content-Type", "application/json");
      return s.app.request(path, { ...init, headers });
    };
    expect((await call("/api/v1/tokens", { token: "writer" })).status).toBe(403);
    expect((await call("/api/v1/libraries", { token: "process" })).status).toBe(403);

    const lib = await call("/api/v1/libraries", {
      method: "POST",
      body: JSON.stringify({ slug: "api-lib" }),
    });
    expect(lib.status).toBe(201);
    const libs = (await (await call("/api/v1/libraries")).json()) as {
      libraries: { slug: string }[];
    };
    expect(libs.libraries.map((l) => l.slug)).toContain("api-lib");

    const human = await call("/api/v1/tokens", {
      method: "POST",
      body: JSON.stringify({ library: "demo", actor: "human:owner", scope: "write" }),
    });
    expect(human.status).toBe(403);
    const made = await call("/api/v1/tokens", {
      method: "POST",
      body: JSON.stringify({
        library: "demo",
        actor: "process:nightly",
        scope: "read",
        expires: "2099-01-01",
      }),
    });
    expect(made.status).toBe(201);
    const token = (await made.json()) as { id: string; secret: string; expires: string };
    expect(token.expires).toBe("2099-01-01T23:59:59.000Z");
    expect((await s.req("/tree", { token: token.secret })).status).toBe(200);
    const listed = (await (await call("/api/v1/tokens")).json()) as { tokens: { id: string }[] };
    expect(listed.tokens.map((t) => t.id)).toContain(token.id);
    expect((await call(`/api/v1/tokens/${token.id}`, { method: "DELETE" })).status).toBe(204);
    expect((await s.req("/tree", { token: token.secret })).status).toBe(401);
  });
});
