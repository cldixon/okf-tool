/**
 * `bun run gate`: the Phase 1 gate against `cf dev` (spec: Phase 1 in detail, Gate), plus
 * the MCP smoke flow on a fresh, empty library.
 *
 * Starts the Worker with fresh local D1, R2 and DO state, seeds one library and write token per
 * sample bundle, imports each bundle as a tarball, exports it, and compares: same parsed
 * frontmatter (generated and verified included) and bodies, byte-identical attachments,
 * synthesized index.md and log.md ignored. Then renders every concept and directory of each bundle
 * in the built-in UI (signed in by a dev magic link), runs the nightly export through the Durable
 * Object into local R2, signs up a second user who must not see the first one's libraries
 * (v2 spec: Phases and gates, A1), and has a fresh account sign up, connect over OAuth and write
 * (A2). Exits non-zero on any mismatch.
 *
 *   bun run gate [--port 8799] [--keep]
 */
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { readTar, writeTar } from "../src/util/tar";
import { compareBundle } from "../test/compare";
import { BUNDLES, loadBundle } from "../test/fixtures";
import { WORKER_DIR } from "./cf";
import { mcpSmoke } from "./mcp-smoke";
import { seed } from "./seed";

const { values } = parseArgs({
  options: { port: { type: "string" }, keep: { type: "boolean" } },
});
const port = Number(values.port ?? 8799);
const base = `http://127.0.0.1:${port}`;

/**
 * `cf dev` keeps local state in .wrangler/state beside cloudflare.config.ts and takes no state
 * directory, so the gate runs it from a throwaway project under worker/.gate/: the config files
 * copied, src/, migrations/ and node_modules/ linked, and a .dev.vars with DEV_SIGNIN=1 so
 * sign-in links are shown on the page (on loopback only) instead of mailed.
 */
mkdirSync(join(WORKER_DIR, ".gate"), { recursive: true });
const project = mkdtempSync(join(WORKER_DIR, ".gate", "run-"));
for (const f of ["cloudflare.config.ts", "wrangler.config.ts", "package.json", "tsconfig.json"]) {
  copyFileSync(join(WORKER_DIR, f), join(project, f));
}
for (const d of ["src", "migrations", "node_modules"]) {
  symlinkSync(join(WORKER_DIR, d), join(project, d));
}
writeFileSync(join(project, ".dev.vars"), "DEV_SIGNIN=1\n");
const state = join(project, ".wrangler/state");

console.log(`project: ${project}`);
const tokens: ({ bundle: string } & Awaited<ReturnType<typeof seed>>)[] = [];
for (const b of BUNDLES) {
  tokens.push({ bundle: b, ...(await seed({ slug: b.replace(/_/g, "-"), persistTo: state })) });
}
const mcpToken = (await seed({ slug: "mcp", actor: "claude-code/gate", persistTo: state })).token;

const dev = Bun.spawn(["bunx", "cf", "dev", "--port", String(port)], {
  cwd: project,
  env: { ...process.env, CF_SEND_TELEMETRY: "false", CI: "1" },
  stdout: "pipe",
  stderr: "pipe",
});

async function waitForHealth() {
  for (let i = 0; i < 120; i++) {
    try {
      const r = await fetch(`${base}/healthz`);
      if (r.ok) return;
    } catch {}
    await Bun.sleep(500);
  }
  throw new Error("cf dev did not become healthy");
}

/** Signs in by a dev magic link (DEV_SIGNIN=1 shows it on the page); returns the session cookie. */
async function signIn(email: string): Promise<string> {
  const asked = await fetch(`${base}/app/sign-in`, {
    method: "POST",
    headers: { Origin: base },
    body: new URLSearchParams({ email, next: "/app" }),
  });
  const html = await asked.text();
  const t = /[?&]t=([0-9a-f]{64})/.exec(html.replace(/&#38;/g, "&"))?.[1];
  if (!t) throw new Error(`sign-in for ${email}: ${asked.status} ${html.slice(0, 300)}`);
  const done = await fetch(`${base}/app/sign-in/link`, {
    method: "POST",
    headers: { Origin: base },
    body: new URLSearchParams({ t, next: "/app" }),
    redirect: "manual",
  });
  const cookie = done.headers.get("Set-Cookie")?.split(";")[0];
  if (done.status !== 303 || !cookie) throw new Error(`sign-in link for ${email}: ${done.status}`);
  return cookie;
}

/** The seeded user's session, set once the Worker is up. */
let devCookie = "";

/** A UI request as the seeded user; a redirect (e.g. to sign-in) is not followed. */
function ui(url: string, init: RequestInit = {}, cookie = devCookie) {
  const headers = new Headers(init.headers);
  headers.set("Cookie", cookie);
  return fetch(url, { ...init, headers, redirect: "manual" });
}

/** Fetches the library page, every directory page and every concept page of a library. */
async function uiPages(owner: string, slug: string, paths: string[]): Promise<string[]> {
  const enc = (p: string) => p.split("/").map(encodeURIComponent).join("/");
  const lib = `${base}/app/libraries/${owner}/${slug}`;
  const concepts = paths.filter((p) => p.endsWith(".md") && !/(^|\/)(index|log)\.md$/.test(p));
  const dirs = new Set<string>();
  for (const p of paths) {
    const parts = p.split("/").slice(0, -1);
    for (let i = 1; i <= parts.length; i++) dirs.add(parts.slice(0, i).join("/"));
  }
  const urls = [
    `${lib}/`,
    `${lib}/ledger`,
    ...[...dirs].map((d) => `${lib}/tree/${enc(d)}/`),
    ...concepts.map((p) => `${lib}/files/${enc(p)}`),
  ];
  const problems: string[] = [];
  for (const url of urls) {
    const r = await ui(url);
    const html = await r.text();
    if (r.status !== 200 || !html.includes("</main>")) {
      problems.push(`${url.slice(base.length)}: ${r.status} ${html.slice(0, 200)}`);
    }
  }
  return problems;
}

/** Runs the daily maintainers through the UI and reads the export back from R2. */
async function nightlyExport(owner: string, slug: string, originals: number): Promise<string[]> {
  const lib = `${base}/app/libraries/${owner}/${slug}`;
  const r = await ui(`${lib}/maintain`, { method: "POST", headers: { Origin: base } });
  const html = await r.text();
  if (r.status !== 200 || !html.includes("Exported to R2")) {
    return [`export now: ${r.status} ${html.slice(0, 200)}`];
  }
  const date = new Date().toISOString().slice(0, 10);
  const tar = await ui(`${lib}/exports/${date}/bundle.tar`);
  if (!tar.ok) return [`nightly bundle.tar: ${tar.status}`];
  const files = readTar(new Uint8Array(await tar.arrayBuffer()));
  // The originals' own index.md and log.md are replaced by synthesized ones, so at least as many.
  if (files.length < originals) return [`nightly bundle has ${files.length} files`];
  const ledger = await ui(`${lib}/exports/${date}/ledger.jsonl`);
  if (!ledger.ok || !(await ledger.text()).includes('"t":"event"')) {
    return [`nightly ledger.jsonl: ${ledger.status}`];
  }
  // The daily alarm was set when the library was first used.
  const home = await (await ui(`${lib}/`)).text();
  if (!home.includes("next run")) return ["no daily maintenance alarm scheduled"];
  return [];
}

/**
 * The Recovery page renders, and a restore in cf dev (no point-in-time recovery there)
 * fails cleanly: a 501 naming the reason, no pre-restore export, the library still answering.
 */
async function restoreUnavailable(owner: string, slug: string): Promise<string[]> {
  const lib = `${base}/app/libraries/${owner}/${slug}`;
  const page = await ui(`${lib}/recovery`);
  if (!page.ok || !(await page.text()).includes("Restore this library to a point in time")) {
    return [`recovery page: ${page.status}`];
  }
  const to = new Date(Date.now() - 5 * 60_000).toISOString().slice(0, 19);
  const r = await ui(`${lib}/recovery`, {
    method: "POST",
    headers: { Origin: base },
    body: new URLSearchParams({ to, confirm: slug }),
  });
  const html = await r.text();
  if (r.status !== 501 || !html.includes("point-in-time recovery")) {
    return [`restore in cf dev: ${r.status} ${html.slice(0, 200)}`];
  }
  const transfer = await (await ui(`${lib}/transfer`)).text();
  if (transfer.includes("before a restore")) return ["a pre-restore export was written"];
  const home = await ui(`${lib}/`);
  if (!home.ok) return [`library after a refused restore: ${home.status}`];
  return [];
}

/**
 * Two accounts cannot see each other (v2 spec: Tenancy): a second user signs up, creates a
 * library with a name the first already uses, and neither reaches the other's.
 */
async function strangers(owner: string, slug: string, token: string): Promise<string[]> {
  const problems: string[] = [];
  const cookie = await signIn("stranger@localhost");
  const created = await ui(
    `${base}/app/libraries`,
    { method: "POST", headers: { Origin: base }, body: new URLSearchParams({ slug }) },
    cookie,
  );
  const theirs = created.headers.get("Location") ?? "";
  if (created.status !== 303 || !theirs.startsWith("/app/libraries/stranger/")) {
    problems.push(`stranger creates ${slug}: ${created.status} ${theirs}`);
  }
  const home = await (await ui(`${base}/app`, {}, cookie)).text();
  if (home.includes(`/app/libraries/${owner}/`)) problems.push("stranger's list shows the dev's");
  const page = await ui(`${base}/app/libraries/${owner}/${slug}/`, {}, cookie);
  if (page.status !== 404) problems.push(`stranger opens the dev's ${slug}: ${page.status}`);
  const mine = await (await ui(`${base}/app`)).text();
  if (mine.includes("/app/libraries/stranger/")) problems.push("dev's list shows the stranger's");
  const cross = await fetch(`${base}/api/v1/libraries/stranger/${slug}/tree`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (cross.status !== 404) problems.push(`dev's token on the stranger's ${slug}: ${cross.status}`);
  return problems;
}

const b64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

/**
 * A fresh account's first run (v2 spec: Phases and gates, A2): sign up, welcome, then connect an
 * MCP client through OAuth with PKCE, as Claude Code would, write through MCP, and see the
 * Connect page notice.
 */
async function freshAccountConnects(): Promise<string[]> {
  const cookie = await signIn("newcomer@localhost");
  const home = await ui(`${base}/app`, {}, cookie);
  if (home.headers.get("Location") !== "/app/welcome") return [`first /app: ${home.status}`];
  const welcomed = await ui(
    `${base}/app/welcome`,
    {
      method: "POST",
      headers: { Origin: base },
      body: new URLSearchParams({ handle: "newcomer", library: "notes", starter: "1" }),
    },
    cookie,
  );
  const connect = `${base}${welcomed.headers.get("Location") ?? ""}`;
  if (welcomed.status !== 303 || !connect.endsWith("/app/libraries/newcomer/notes/connect")) {
    return [`welcome: ${welcomed.status} ${connect}`];
  }
  if (!(await (await ui(connect, {}, cookie)).text()).includes("No agent has written yet")) {
    return ["connect page before the agent"];
  }

  const redirect = "https://claude.ai/api/mcp/auth_callback";
  const reg = await fetch(`${base}/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: "Gate",
      redirect_uris: [redirect],
      token_endpoint_auth_method: "none",
    }),
  });
  const { client_id } = (await reg.json()) as { client_id: string };
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = b64url(
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))),
  );
  const authorize = `${base}/app/authorize?${new URLSearchParams({
    response_type: "code",
    client_id,
    redirect_uri: redirect,
    scope: "okf:read okf:write",
    state: "gate",
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource: `${base}/mcp`,
  })}`;
  const consent = await ui(authorize, {}, cookie);
  const html = await consent.text();
  const handle = /name="handle" value="([^"]+)"/.exec(html)?.[1];
  if (!handle) return [`consent page: ${consent.status} ${html.slice(0, 200)}`];
  const consentCookies = consent.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
  const approved = await ui(
    authorize,
    {
      method: "POST",
      headers: { Origin: base },
      body: new URLSearchParams({
        handle,
        decision: "approve",
        library: "notes",
        new_library: "",
        access: "write",
        prefix: "",
        actor: "claude-code/gate",
        tiers: "all",
      }),
    },
    `${cookie}; ${consentCookies}`,
  );
  const code = new URL(approved.headers.get("Location") ?? redirect).searchParams.get("code");
  if (!code) return [`consent: ${approved.status}`];
  const tok = await fetch(`${base}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirect,
      client_id,
      code_verifier: verifier,
    }),
  });
  const { access_token } = (await tok.json()) as { access_token?: string };
  if (!access_token) return [`token: ${tok.status}`];
  if (!(await mcpSmoke({ url: base, token: access_token }))) return ["MCP over OAuth"];
  const after = await (await ui(connect, {}, cookie)).text();
  if (!after.includes("Last agent write: claude-code/gate"))
    return ["connect page after the agent"];

  // Deleting the library wipes its Durable Object and ends the connection.
  const lib = connect.replace(/\/connect$/, "");
  await ui(`${lib}/maintain`, { method: "POST", headers: { Origin: base } }, cookie);
  const del = await ui(
    `${lib}/delete`,
    { method: "POST", headers: { Origin: base }, body: new URLSearchParams({ confirm: "notes" }) },
    cookie,
  );
  if (del.status !== 303)
    return [`delete library: ${del.status} ${(await del.text()).slice(0, 200)}`];
  const gone = await ui(`${lib}/`, {}, cookie);
  if (gone.status !== 404) return [`deleted library page: ${gone.status}`];
  const mcp = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${access_token}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  if (mcp.status !== 401) return [`MCP after delete: ${mcp.status}`];
  return [];
}

let failed = false;
try {
  await waitForHealth();
  devCookie = await signIn("dev@localhost");
  for (const t of tokens) {
    const headers = { Authorization: `Bearer ${t.token}` };
    const lib = `${base}/api/v1/libraries/${t.owner}/${t.slug}`;
    const original = loadBundle(t.bundle);
    const imp = await fetch(`${lib}/import?source=fixtures/${t.bundle}`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/x-tar" },
      body: writeTar(original),
    });
    if (!imp.ok) throw new Error(`import ${t.bundle}: ${imp.status} ${await imp.text()}`);
    const res = (await imp.json()) as { files: number; seq: number; warnings: unknown[] };

    const exp = await fetch(`${lib}/export`, { headers });
    if (!exp.ok) throw new Error(`export ${t.bundle}: ${exp.status} ${await exp.text()}`);
    const exported = new Map(
      readTar(new Uint8Array(await exp.arrayBuffer())).map((f) => [f.path, f.bytes]),
    );
    const problems = compareBundle(original, exported);
    const concepts = original.filter(
      (f) => f.path.endsWith(".md") && !/(^|\/)(index|log)\.md$/.test(f.path),
    ).length;
    const attachments = original.filter((f) => !f.path.endsWith(".md")).length;
    const status = problems.length === 0 ? "PASS" : "FAIL";
    console.log(
      `${status} ${t.bundle}: ${concepts} concepts, ${attachments} attachments, ${res.seq} events, ${res.warnings.length} files with lint`,
    );
    for (const p of problems) console.log(`  - ${p}`);
    if (problems.length > 0) failed = true;

    const uiProblems = await uiPages(
      t.owner,
      t.slug,
      original.map((f) => f.path),
    );
    console.log(`${uiProblems.length === 0 ? "PASS" : "FAIL"} ${t.bundle}: UI pages render`);
    for (const p of uiProblems) console.log(`  - ${p}`);
    if (uiProblems.length > 0) failed = true;
    const exportProblems = await nightlyExport(t.owner, t.slug, original.length);
    console.log(
      `${exportProblems.length === 0 ? "PASS" : "FAIL"} ${t.bundle}: nightly export to R2 via the Durable Object`,
    );
    for (const p of exportProblems) console.log(`  - ${p}`);
    if (exportProblems.length > 0) failed = true;
    const restoreProblems = await restoreUnavailable(t.owner, t.slug);
    console.log(
      `${restoreProblems.length === 0 ? "PASS" : "FAIL"} ${t.bundle}: restore refused cleanly without point-in-time recovery`,
    );
    for (const p of restoreProblems) console.log(`  - ${p}`);
    if (restoreProblems.length > 0) failed = true;
  }
  const first = tokens[0];
  const tenancy = first ? await strangers(first.owner, first.slug, first.token) : ["no library"];
  console.log(
    `${tenancy.length === 0 ? "PASS" : "FAIL"} a second account sees nothing of the first`,
  );
  for (const p of tenancy) console.log(`  - ${p}`);
  if (tenancy.length > 0) failed = true;
  const fresh = await freshAccountConnects();
  console.log(
    `${fresh.length === 0 ? "PASS" : "FAIL"} a fresh account signs up, connects over OAuth, writes, deletes`,
  );
  for (const p of fresh) console.log(`  - ${p}`);
  if (fresh.length > 0) failed = true;
  const mcpOk = await mcpSmoke({ url: base, token: mcpToken });
  console.log(`${mcpOk ? "PASS" : "FAIL"} MCP smoke on an empty library`);
  if (!mcpOk) failed = true;
} catch (e) {
  failed = true;
  console.error(e);
  console.error((await new Response(dev.stderr).text()).slice(-4000));
} finally {
  dev.kill();
  await dev.exited;
  if (!values.keep) rmSync(project, { recursive: true, force: true });
}
console.log(failed ? "Gate FAILED" : "Gate passed");
process.exit(failed ? 1 : 0);
