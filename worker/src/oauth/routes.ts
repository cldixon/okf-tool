import {
  AuthorizationError,
  type AuthRequest,
  CimdFetchError,
  type ConsentDescription,
  type OAuthHelpers,
} from "@cloudflare/workers-oauth-provider";
import type { Hono } from "hono";
import type { LibraryRef, User } from "../accounts";
import { checkSlug } from "../accounts";
import type { Deps } from "../app";
import type { TokenInfo } from "../auth";
import { normalizeDir } from "../okf/paths";
import { signedIn } from "../signin";
import { OkfError } from "../store/errors";
import { type ConsentForm, consentPage, grantsPage, messagePage } from "./pages";

/** OAuth scopes (spec: Apps under Auth). A grant never carries more than the person approved. */
export const SCOPES = ["okf:read", "okf:write"];

/** What an approved grant carries: exactly a token's fields, so every permission rule applies. */
export interface GrantProps {
  token: TokenInfo;
}

const AGENT_ACTOR = /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/;

type AppEnv = { Bindings: Cloudflare.Env };

function defaultActor(details: ConsentDescription): string {
  const base = (details.clientDomain ?? details.clientName ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${base || "app"}/connector`;
}

function defaultForm(
  request: AuthRequest,
  details: ConsentDescription,
  libs: LibraryRef[],
): ConsentForm {
  const wantsWrite = request.scope.length === 0 || request.scope.includes("okf:write");
  return {
    library: libs[0]?.slug ?? "",
    newLibrary: libs.length === 0 ? "notes" : "",
    access: wantsWrite ? "write" : "read",
    prefix: "",
    actor: defaultActor(details),
    tiers: "all",
  };
}

function readForm(form: FormData): ConsentForm {
  const s = (k: string) => String(form.get(k) ?? "").trim();
  return {
    library: s("library"),
    newLibrary: s("new_library"),
    access: s("access") === "read" ? "read" : "write",
    prefix: s("prefix"),
    actor: s("actor").toLowerCase(),
    tiers: s("tiers") === "files" ? "files" : "all",
  };
}

/** Checks the form; returns an error message for the person, or null. */
function validate(form: ConsentForm, libs: LibraryRef[]): string | null {
  if (!AGENT_ACTOR.test(form.actor)) {
    return "The ledger name must look like app/label, e.g. claude-ai/connector: lowercase letters, digits, dots, hyphens or underscores on each side of one slash.";
  }
  if (form.library === "") {
    try {
      checkSlug(form.newLibrary);
    } catch (e) {
      return (e as OkfError).message;
    }
    if (libs.some((l) => l.slug === form.newLibrary.toLowerCase())) {
      return `You already have a library named ${form.newLibrary}; pick it from the list.`;
    }
  } else if (!libs.some((l) => l.slug === form.library)) {
    return "Pick a library from the list, or create a new one.";
  }
  if (form.prefix.includes("..")) return "The directory cannot contain '..'.";
  return null;
}

function html(body: string, headers?: Headers, status = 200): Response {
  const h = new Headers(headers);
  h.set("Content-Type", "text/html; charset=utf-8");
  h.set("X-Frame-Options", "DENY");
  h.set(
    "Content-Security-Policy",
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https: http://localhost:* http://127.0.0.1:*; frame-ancestors 'none'",
  );
  return new Response(body, { status, headers: h });
}

function authError(e: unknown): Response {
  if (e instanceof AuthorizationError && e.redirectTo) return Response.redirect(e.redirectTo, 302);
  if (e instanceof AuthorizationError)
    return messagePage("Cannot connect this app", e.description, 400);
  if (e instanceof CimdFetchError) {
    return messagePage("Cannot connect this app", "This app could not be verified.", 400);
  }
  throw e;
}

/**
 * /app/authorize and /app/grants, for the signed-in person (spec: Apps under Auth). Consent lists
 * only their own libraries, and a grant belongs to their account (v2 spec: Tenancy).
 */
export function registerAppRoutes<E extends AppEnv>(
  app: Hono<E>,
  deps: (env: Cloudflare.Env) => Deps,
) {
  app.get("/app/authorize", async (c) => {
    const d = deps(c.env);
    const accounts = d.accounts;
    const user = await signedIn(c.req.raw, c.env, d);
    if (user instanceof Response) return user;
    const oauth: OAuthHelpers = c.env.OAUTH_PROVIDER;
    try {
      const request = await oauth.parseAuthRequest(c.req.raw);
      const details = await oauth.describeConsent(request);
      const libs = await accounts.libraries(user.id);
      const consent = await oauth.beginConsent(request);
      return html(
        consentPage({
          details,
          handle: consent.handle,
          signedInAs: user.email,
          libraries: libs,
          form: defaultForm(request, details, libs),
        }),
        consent.headers,
      );
    } catch (e) {
      return authError(e);
    }
  });

  app.post("/app/authorize", async (c) => {
    const d = deps(c.env);
    const accounts = d.accounts;
    const user = await signedIn(c.req.raw, c.env, d);
    if (user instanceof Response) return user;
    const oauth: OAuthHelpers = c.env.OAUTH_PROVIDER;
    const body = await c.req.formData();
    const handle = String(body.get("handle") ?? "");
    try {
      if (body.get("decision") !== "approve") {
        const denied = await oauth.denyConsent(c.req.raw, handle);
        return new Response(null, { status: 302, headers: denied.headers });
      }
      const form = readForm(body);
      const libs = await accounts.libraries(user.id);
      const problem = validate(form, libs);
      if (problem) {
        // The handle is still unused, so the same page can be shown again with the error. The
        // form posts to its own URL, so the original authorization request is in the query.
        const oauthReq = await oauth.parseAuthRequest(new Request(c.req.url)).catch(() => null);
        const details: ConsentDescription = oauthReq
          ? await oauth.describeConsent(oauthReq)
          : {
              clientId: "",
              clientName: "this app",
              redirectUri: "",
              redirectHost: "the app",
              redirectIsLoopback: false,
              scope: [],
            };
        return html(
          consentPage({
            details,
            handle,
            signedInAs: user.email,
            libraries: libs,
            form,
            error: problem,
          }),
          undefined,
          400,
        );
      }
      const scope = form.access === "write" ? ["okf:read", "okf:write"] : ["okf:read"];
      const approved = await oauth.approveConsent(c.req.raw, handle, { scope });
      const library =
        form.library === ""
          ? await accounts.createLibrary(form.newLibrary, user)
          : (libs.find((l) => l.slug === form.library) as LibraryRef);
      const prefix = normalizeDir(form.prefix) || null;
      const props: GrantProps = {
        token: {
          id: "oauth",
          actor: form.actor,
          scope: form.access,
          prefix,
          mcp_tiers: form.tiers,
          library: {
            id: library.id,
            slug: library.slug,
            do_id: library.do_id,
            owner: library.owner,
          },
        },
      };
      const { redirectTo } = await oauth.completeAuthorization({
        request: approved.request,
        userId: user.id,
        metadata: {
          library: library.slug,
          actor: form.actor,
          access: form.access,
          prefix,
          tiers: form.tiers,
        },
        scope,
        props,
      });
      approved.headers.set("Location", redirectTo);
      return new Response(null, { status: 302, headers: approved.headers });
    } catch (e) {
      if (e instanceof OkfError) return messagePage("Cannot connect this app", e.message, e.status);
      return authError(e);
    }
  });

  app.get("/app/grants", async (c) => {
    const user = await signedIn(c.req.raw, c.env, deps(c.env));
    if (user instanceof Response) return user;
    return html(await renderGrants(c.env.OAUTH_PROVIDER, user, c.req.query("notice")));
  });

  app.post("/app/grants/revoke", async (c) => {
    const user = await signedIn(c.req.raw, c.env, deps(c.env));
    if (user instanceof Response) return user;
    // Session cookies are SameSite=Lax, and every post must also come from this site.
    const origin = c.req.header("Origin");
    if (origin !== new URL(c.req.url).origin) {
      return messagePage("Refused", "Revoke requests must come from this site.", 403);
    }
    const id = String((await c.req.formData()).get("grant") ?? "");
    const oauth: OAuthHelpers = c.env.OAUTH_PROVIDER;
    await oauth.revokeGrant(id, user.id);
    return c.redirect("/app/grants?notice=Connection+revoked.", 303);
  });
}

async function renderGrants(oauth: OAuthHelpers, user: User, notice?: string) {
  const grants = [];
  let cursor: string | undefined;
  do {
    const page = await oauth.listUserGrants(user.id, { cursor, limit: 100 });
    grants.push(...page.items);
    cursor = page.cursor;
  } while (cursor);
  const names = new Map<string, string>();
  for (const id of new Set(grants.map((g) => g.clientId))) {
    const client = await oauth.lookupClient(id).catch(() => null);
    if (client?.clientName) names.set(id, client.clientName);
  }
  grants.sort((a, b) => b.createdAt - a.createdAt);
  return grantsPage({ signedInAs: user.email, grants, clientNames: names, notice });
}
