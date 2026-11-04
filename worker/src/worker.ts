import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { type AgentKey, agentName, connectionAgent, tokenAgent } from "./agents";
import { actedBy, createApp, type Deps } from "./app";
import { hostRedirect, hostsFrom } from "./hosts";
import { imagesService } from "./images";
import { handleMcp, type McpContext } from "./mcp/server";
import { notifying, postComment } from "./notify";
import { type GrantProps, SCOPES } from "./oauth/routes";
import { mcpOp, withCostHeader, withCosts } from "./op-costs";
import { RENDER_UNAVAILABLE } from "./render";
import { OkfError } from "./store/errors";
import { createLibraryForGrant, grantAgent, grantLibraries } from "./tenancy";
import { type Admission, admit, mcpWrites, tokenAdmission } from "./usage";

const HOUR = 3600;

/**
 * The Worker's fetch handler: Cloudflare's OAuth provider in front of everything (spec: Apps under
 * Auth). It serves OAuth discovery, /register and /token, guards /mcp (OAuth access tokens, or our
 * own bearer tokens through resolveExternalToken), and hands every other request to the app.
 *
 * The canonical resource is `<origin>/mcp`, so one provider is built per origin the Worker is
 * reached on (workers.dev, a custom domain, localhost in dev).
 */
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** RFC 6750's answer to a token that no longer works: a Bearer challenge naming the metadata. */
function invalidToken(origin: string, why: string): Response {
  const e = new OkfError(401, "invalid_token", why);
  return Response.json(e.toJSON(), {
    status: 401,
    headers: {
      "WWW-Authenticate": `Bearer realm="OAuth", resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp", error="invalid_token", error_description="${why}"`,
      "Cache-Control": "no-store",
    },
  });
}

/** The client's name and version from an MCP initialize request, or null for anything else. */
function initializeInfo(body: unknown): string | null {
  const msgs = Array.isArray(body) ? body : [body];
  for (const m of msgs) {
    const msg = m as {
      method?: string;
      params?: { clientInfo?: { name?: unknown; version?: unknown } };
    };
    if (msg?.method !== "initialize") continue;
    const ci = msg.params?.clientInfo;
    const name = typeof ci?.name === "string" ? ci.name : "";
    const version = typeof ci?.version === "string" ? ci.version : "";
    return `${name} ${version}`.trim();
  }
  return null;
}

export function createWorker(deps: (env: Cloudflare.Env) => Deps): {
  fetch: NonNullable<ExportedHandler<Env>["fetch"]>;
} {
  const app = createApp(deps);
  const providers = new Map<string, OAuthProvider<Env>>();

  const providerFor = (origin: string) => {
    let provider = providers.get(origin);
    if (provider) return provider;
    const resource = `${origin}/mcp`;
    provider = new OAuthProvider<Env>({
      apiRoute: "/mcp",
      apiHandler: {
        async fetch(request, env, ctx) {
          const props = (ctx as unknown as { props: GrantProps }).props;
          const d = deps(env);
          // An app connection reaches the account's libraries as of now; a bearer token (or a
          // connection approved before account-level access) reaches its one library.
          let who: Admission;
          let caller: Pick<
            McpContext,
            "actor" | "scope" | "tiers" | "libraries" | "by" | "createLibrary"
          >;
          /** The agent behind the connection, as the person's agent on its platform. */
          let agent: { userId: string; key: AgentKey } | null = null;
          if (props.grant) {
            const g = props.grant;
            const reach = await grantLibraries(d.accounts, g, d.authCache);
            // The account is gone (deleted, or a data reset) or suspended: the token is dead.
            // Say so as OAuth does, so the client signs in again instead of showing no tools.
            if (!reach) return invalidToken(origin, "This account is suspended or deleted.");
            who = { key: `grant:${g.id}|${g.actor}`, account: reach.user.handle };
            caller = {
              actor: g.actor,
              scope: g.scope,
              tiers: g.tiers,
              libraries: reach.libraries,
              // The person and their agent, even before the connection reaches any library.
              by: { person: reach.user.id, agent: grantAgent(g, reach.user.id) },
              // Refused in createLibraryForGrant unless the grant allows it (TEMPRA-100).
              createLibrary: async (input) => {
                const made = await createLibraryForGrant(d.accounts, g, input);
                return { token: made.token, title: made.title, description: made.description };
              },
            };
            agent = { userId: reach.user.id, key: connectionAgent(g.client ?? {}) };
          } else if (props.token) {
            const t = props.token;
            who = tokenAdmission(t);
            caller = {
              actor: t.actor,
              scope: t.scope,
              tiers: t.mcp_tiers,
              libraries: [t],
              by: actedBy(t),
            };
            if (t.created_by && t.agent) agent = { userId: t.created_by, key: tokenAgent(t.actor) };
          } else {
            return new Response(null, { status: 401 });
          }
          let write = false;
          let op = "mcp:";
          if (request.method === "POST") {
            const body = await request
              .clone()
              .json()
              .catch(() => null);
            write = mcpWrites(body);
            op = mcpOp(body);
            // What the client says about itself, once per session (TEMPRA-75): a claim, kept
            // to tell agents apart and never used to authorize.
            const info = initializeInfo(body);
            if (agent && info !== null) {
              await d.accounts
                .recordAgent(agent.userId, agent.key, {
                  client: info,
                  userAgent: request.headers.get("User-Agent"),
                })
                .catch((e) => console.error("recordAgent", e));
            }
          }
          try {
            await admit(d, who, write);
          } catch (e) {
            if (e instanceof OkfError) return Response.json(e.toJSON(), { status: e.status });
            throw e;
          }
          // What the tool call cost its library's object, metered under its name (TEMPRA-228).
          const { value: res, cost } = await withCosts(() =>
            handleMcp(request, {
              ...caller,
              // Reads over MCP are counted as MCP's (TEMPRA-220).
              open: (t) => notifying(d, t, d.library(t, "mcp"), (p) => ctx.waitUntil(p)),
              comment: (t, req, action) => postComment(d, t, d.library(t, "mcp"), req, action),
              about: (id) => d.accounts.about(id),
              agentNames: async (ids) =>
                new Map((await d.accounts.agents(ids)).map((a) => [a.id, agentName(a)])),
              blobs: d.blobs,
              images: d.images ?? imagesService({ blobs: d.blobs }),
              meter: (e) => d.meter?.({ ...e, account: who.account }),
              fetch: d.fetch,
              // The render tool and read's diagrams (TEMPRA-166), counted per account.
              render: (req, library) =>
                d.renderDiagram
                  ? d.renderDiagram(req, { account: who.account, library })
                  : Promise.resolve({ error: { message: RENDER_UNAVAILABLE, line: 0, column: 0 } }),
              poster: (req, library) =>
                d.posterFrame
                  ? d.posterFrame(req, { account: who.account, library })
                  : Promise.resolve({ error: RENDER_UNAVAILABLE }),
              allowRender: async () =>
                (await d.rateLimit?.("render", `render:${who.account}`)) ?? true,
              origin,
            }),
          );
          if (cost.calls > 0) {
            d.meter?.({ kind: "cost", account: who.account, library: who.library, op, cost });
          }
          return withCostHeader(request, res, cost);
        },
      },
      defaultHandler: { fetch: (request, env, ctx) => app.fetch(request, env, ctx) },
      authorizeEndpoint: "/authorize",
      tokenEndpoint: "/token",
      clientRegistrationEndpoint: "/register",
      clientIdMetadataDocumentEnabled: true,
      scopesSupported: SCOPES,
      accessTokenTTL: HOUR,
      refreshTokenTTL: 30 * 24 * HOUR,
      resourceMetadata: {
        resource,
        authorization_servers: [origin],
        bearer_methods_supported: ["header"],
        resource_name: "Tempra",
      },
      // Bearer tokens minted for Claude Code, scripts and scheduled tasks keep working on /mcp.
      resolveExternalToken: async ({ token, env }) => {
        try {
          const info = await deps(env).authenticate(token);
          const props: GrantProps = { token: info };
          return { props, audience: resource };
        } catch {
          return null;
        }
      },
    });
    providers.set(origin, provider);
    return provider;
  };

  return {
    fetch(request, env, ctx) {
      const url = new URL(request.url);
      // Plain http reaches the Worker when the zone does not force https. Only https (or a
      // loopback host in dev) is an origin: the OAuth metadata and session cookies need it.
      if (url.protocol === "http:" && !LOOPBACK.has(url.hostname)) {
        url.protocol = "https:";
        return Response.redirect(url.toString(), 308);
      }
      // www to the apex, and a browser's page load on the former host to the same path here
      // (TEMPRA-276, hosts.ts); agents and OAuth on the former host are served in place.
      const moved = hostRedirect(request, hostsFrom(env));
      if (moved) return moved;
      return providerFor(url.origin).fetch(request, env, ctx);
    },
  };
}
