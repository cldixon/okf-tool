import { describe, expect, test } from "bun:test";
import { type Api, cloudflareApi, ensureAccess, PERMISSIONS } from "../scripts/access";

const WANT = {
  name: "tempra-admin",
  host: "admin.tempra.dev",
  operator: "Owner@Example.com",
  sessionDuration: "2h",
};

/** Access as an account holds it: what exists, and every write made. */
function fakeAccess(start: { idps?: unknown[]; policies?: unknown[]; apps?: unknown[] } = {}) {
  const state = {
    idps: [...(start.idps ?? [{ id: "cf", type: "cloudflare" }])] as Record<string, unknown>[],
    policies: [...(start.policies ?? [])] as Record<string, unknown>[],
    apps: [...(start.apps ?? [])] as Record<string, unknown>[],
  };
  const writes: [string, string, unknown][] = [];
  let n = 0;
  const api: Api = async (method, path, body) => {
    if (method !== "GET") writes.push([method, path, body]);
    const b = body as Record<string, unknown>;
    if (path === "/access/organizations") return { auth_domain: "team.cloudflareaccess.com" };
    if (path === "/access/identity_providers") {
      if (method === "GET") return state.idps;
      const made = { id: `idp-${++n}`, ...b };
      state.idps.push(made);
      return made;
    }
    if (path.startsWith("/access/policies")) {
      if (method === "GET") return state.policies;
      if (method === "POST") {
        const made = { id: `pol-${++n}`, ...b };
        state.policies.push(made);
        return made;
      }
      const id = path.split("/").at(-1);
      const i = state.policies.findIndex((p) => p.id === id);
      state.policies[i] = { id, ...b };
      return state.policies[i];
    }
    if (path.startsWith("/access/apps")) {
      if (method === "GET") return state.apps;
      const id = method === "POST" ? `app-${++n}` : path.split("/").at(-1);
      const made = { id, aud: `aud-${id}`, ...b };
      if (method === "POST") state.apps.push(made);
      else state.apps[state.apps.findIndex((a) => a.id === id)] = made;
      return made;
    }
    throw new Error(`unexpected ${method} ${path}`);
  };
  return { api, state, writes };
}

describe("Access from config (TEMPRA-278)", () => {
  test("a fresh account gets the PIN login, the policy and the application", async () => {
    const f = fakeAccess();
    const got = await ensureAccess(f.api, WANT);
    expect(got.team).toBe("team.cloudflareaccess.com");
    expect(got.aud).toMatch(/^aud-app-/);
    expect(f.writes.map(([m, p]) => `${m} ${p}`)).toEqual([
      "POST /access/identity_providers",
      "POST /access/policies",
      "POST /access/apps",
    ]);
    const [, , app] = f.writes[2] ?? [];
    expect(app).toMatchObject({
      domain: "admin.tempra.dev",
      type: "self_hosted",
      session_duration: "2h",
      auto_redirect_to_identity: true,
    });
    const [, , policy] = f.writes[1] ?? [];
    expect(policy).toMatchObject({
      decision: "allow",
      include: [{ email: { email: "owner@example.com" } }],
    });
  });

  test("running again changes nothing; a drifted application or policy is corrected", async () => {
    const f = fakeAccess();
    await ensureAccess(f.api, WANT);
    f.writes.length = 0;
    const again = await ensureAccess(f.api, WANT);
    expect(again.changes).toEqual([]);
    expect(f.writes).toEqual([]);
    // Someone lengthened the session and added a second email in the dashboard.
    const app = f.state.apps[0] as Record<string, unknown>;
    app.session_duration = "24h";
    const policy = f.state.policies[0] as Record<string, unknown>;
    policy.include = [{ email: { email: "owner@example.com" } }, { email: { email: "x@y.z" } }];
    const fixed = await ensureAccess(f.api, WANT);
    expect(fixed.changes).toHaveLength(2);
    expect(f.writes.map(([m]) => m)).toEqual(["PUT", "PUT"]);
    expect((f.state.apps[0] as Record<string, unknown>).session_duration).toBe("2h");
    // Nothing it does not manage is touched, and nothing is ever deleted.
    expect(f.state.idps.map((i) => i.type)).toEqual(["cloudflare", "onetimepin"]);
  });

  test("a dry run reads only", async () => {
    const f = fakeAccess();
    const got = await ensureAccess(f.api, WANT, true);
    expect(f.writes).toEqual([]);
    expect(got.changes).toHaveLength(3);
    expect(got.aud).toBe("");
  });

  test("a token without the Access permissions says which ones it needs", async () => {
    const api = cloudflareApi("acc", "t", (async () =>
      Response.json(
        { success: false, errors: [{ code: 10000, message: "Authentication error" }] },
        { status: 403 },
      )) as unknown as typeof fetch);
    await expect(ensureAccess(api, WANT)).rejects.toThrow(PERMISSIONS);
  });
});
