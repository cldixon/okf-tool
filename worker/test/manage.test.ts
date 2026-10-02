import { describe, expect, test } from "bun:test";
import { readTar, writeTar } from "../src/util/tar";
import { setup } from "./harness";

type S = ReturnType<typeof setup>;
const LIB = "/app/libraries/owner/demo";
const ORIGIN = "http://localhost";

async function page(s: S, path: string) {
  const r = await s.app.request(path);
  return { status: r.status, html: await r.text(), headers: r.headers };
}

function post(s: S, path: string, body: URLSearchParams | FormData, origin = ORIGIN) {
  return s.app.request(path, {
    method: "POST",
    headers: { Origin: origin },
    body,
    redirect: "manual",
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
  test("verify the current version from the concept page", async () => {
    const s = setup();
    await put(s, "a.md", "---\ntype: Note\n---\nChecked content.\n");
    const before = await page(s, `${LIB}/files/a.md`);
    expect(before.html).toContain("No human has verified this concept.");
    expect(before.html).toContain(`action="${LIB}/verify/a.md"`);

    const forged = await post(
      s,
      `${LIB}/verify/a.md`,
      new URLSearchParams(),
      "https://evil.example",
    );
    expect(forged.status).toBe(403);

    const done = await post(s, `${LIB}/verify/a.md`, new URLSearchParams({ note: "read it" }));
    expect(done.status).toBe(303);
    const after = await page(s, done.headers.get("Location") ?? "");
    expect(after.html).toContain("Verified as human:owner");
    expect(after.html).toContain("human-reviewed</span> by human:owner");
    expect(after.html).not.toContain(`action="${LIB}/verify/a.md"`);
    const ledger = await page(s, `${LIB}/ledger`);
    expect(ledger.html).toContain("op-verify");
    expect(ledger.html).toContain("read it");

    // The next edit lapses it.
    const hash = s.store().read("a.md");
    if (hash.kind !== "concept") throw new Error();
    await s.req("/files/a.md", {
      method: "PUT",
      headers: { "Content-Type": "text/markdown", "If-Match": `"${hash.hash}"` },
      body: "---\ntype: Note\n---\nChanged.\n",
    });
    const lapsed = await page(s, `${LIB}/files/a.md`);
    expect(lapsed.html).toContain("but the content has changed since");
    expect(lapsed.html).toContain(`action="${LIB}/verify/a.md"`);
  });

  test("the work queue page lists and filters items", async () => {
    const s = setup();
    await put(s, "a.md", "---\ntype: Note\n---\nSee [gone](/gone.md).\n");
    await put(s, "b.md", "---\ntitle: No type\n---\nx\n");
    const all = await page(s, `${LIB}/work`);
    expect(all.html).toContain("broken link");
    expect(all.html).toContain("links to missing /gone.md");
    expect(all.html).toContain(`href="${LIB}/files/b.md"`);
    const lint = await page(s, `${LIB}/work?kind=lint`);
    expect(lint.html).toContain("b.md");
    expect(lint.html).not.toContain("gone.md");
    await put(s, "gone.md", "---\ntype: Note\n---\nhere\n");
    expect((await page(s, `${LIB}/work?kind=broken_link`)).html).toContain("nothing to do");
  });

  test("export downloads the bundle; import adds files as one request by the human", async () => {
    const s = setup();
    await put(s, "a.md", "---\ntype: Note\n---\nA\n");
    const exp = await s.app.request(`${LIB}/export`, { redirect: "manual" });
    expect(exp.status).toBe(302);
    const tar = await s.app.request(exp.headers.get("Location") ?? "");
    expect(tar.headers.get("Content-Disposition")).toContain("demo");
    const paths = readTar(new Uint8Array(await tar.arrayBuffer())).map((f) => f.path);
    expect(paths).toContain("a.md");

    const enc = new TextEncoder();
    const bundle = writeTar([
      { path: "pack/notes/x.md", bytes: enc.encode("---\ntype: Note\n---\nX\n") },
      { path: "pack/notes/y.md", bytes: enc.encode("---\ntitle: lint me\n---\nY\n") },
      { path: "pack/index.md", bytes: enc.encode("# ignored\n") },
    ]);
    const form = new FormData();
    form.set("bundle", new File([bundle], "pack.tar"));
    form.set("strip", "1");
    form.set("note", "bring in the pack");
    const r = await post(s, `${LIB}/import`, form);
    const html = await r.text();
    expect(r.status).toBe(200);
    expect(html).toContain("Imported 2 files from pack.tar");
    expect(html).toContain("1 file with lint");
    expect(s.store().read("notes/x.md").kind).toBe("concept");
    const ledger = await page(s, `${LIB}/ledger`);
    expect(ledger.html).toContain("bring in the pack");
    expect(ledger.html).toContain("human:owner");

    const junk = new FormData();
    junk.set("bundle", new File([enc.encode("not a tar at all")], "x.tar"));
    const bad = await post(s, `${LIB}/import`, junk);
    expect(bad.status).toBe(400);
  });
});

describe("libraries and tokens", () => {
  test("create a library from the list page", async () => {
    const s = setup();
    const r = await post(s, "/app/libraries", new URLSearchParams({ slug: "team-notes" }));
    expect(r.status).toBe(303);
    expect(r.headers.get("Location")).toBe("/app/libraries/owner/team-notes/");
    expect((await s.accounts.libraries("user_1")).map((l) => l.slug)).toContain("team-notes");
    const dup = await post(s, "/app/libraries", new URLSearchParams({ slug: "team-notes" }));
    expect(dup.status).toBe(400);
    expect(await dup.text()).toContain("You already have a library named team-notes.");
  });

  test("mint a token in the UI, use it, and revoke it", async () => {
    const s = setup();
    const form = (actor: string) =>
      new URLSearchParams({
        library: "demo",
        actor,
        scope: "write",
        prefix: "",
        expires: "",
        tiers: "all",
      });
    const bad = await post(s, "/app/tokens", form("human:someone-else"));
    expect(bad.status).toBe(400);
    expect(await bad.text()).toContain("your own actor, human:owner");

    const created = await post(s, "/app/tokens", form("claude-code/laptop"));
    const html = await created.text();
    expect(created.status).toBe(200);
    expect(html).toContain("Shown once.");
    const secret = /<pre class="src wrap">(okf_[^<]+)<\/pre>/.exec(html)?.[1] ?? "";
    expect(html).toContain(`claude mcp add --transport http demo ${ORIGIN}/mcp`);

    const write = await s.req("/files/t.md", {
      method: "PUT",
      token: secret,
      headers: { "Content-Type": "text/markdown" },
      body: "---\ntype: Note\n---\nvia minted token\n",
    });
    expect(write.status).toBeLessThan(300);
    const list = await page(s, "/app/tokens");
    expect(list.html).toContain("claude-code/laptop");
    expect(list.html).toContain("owner@example.com");

    const id = /action="\/app\/tokens\/([^/]+)\/revoke"/.exec(list.html)?.[1] ?? "";
    const revoked = await post(s, `/app/tokens/${id}/revoke`, new URLSearchParams());
    expect(revoked.status).toBe(303);
    expect((await s.req("/files/t.md", { token: secret })).status).toBe(401);
    expect((await page(s, "/app/tokens?done=revoke")).html).toContain("Token revoked.");

    // Your own human: actor is allowed in the UI.
    expect((await post(s, "/app/tokens", form("human:owner"))).status).toBe(200);
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
