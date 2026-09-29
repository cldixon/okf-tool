import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { createApp, type Deps } from "./app";
import { handleMcp } from "./mcp/server";
import { type GrantProps, SCOPES } from "./oauth/routes";

const HOUR = 3600;

/**
 * The Worker's fetch handler: Cloudflare's OAuth provider in front of everything (spec: Apps under
 * Auth). It serves OAuth discovery, /register and /token, guards /mcp (OAuth access tokens, or our
 * own bearer tokens through resolveExternalToken), and hands every other request to the app.
 *
 * The canonical resource is `<origin>/mcp`, so one provider is built per origin the Worker is
 * reached on (workers.dev, a custom domain, localhost in dev).
 */
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
          const { token } = (ctx as unknown as { props: GrantProps }).props;
          const d = deps(env);
          return handleMcp(request, { token, lib: d.library(token), blobs: d.blobs, origin });
        },
      },
      defaultHandler: { fetch: (request, env, ctx) => app.fetch(request, env, ctx) },
      authorizeEndpoint: "/app/authorize",
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
        resource_name: "OKF library",
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
      return providerFor(new URL(request.url).origin).fetch(request, env, ctx);
    },
  };
}
