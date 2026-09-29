import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";

/** Secrets and injected helpers that `wrangler types` does not know about. */
interface AuthEnv {
  /** The Access team domain, e.g. https://<team>.cloudflareaccess.com (secret). */
  ACCESS_TEAM_DOMAIN?: string;
  /** The audience tag of the Access application covering /app/* (secret). */
  ACCESS_AUD?: string;
  /** Local dev only: the signed-in email for /app/* when Access is not configured. */
  DEV_ACCESS_EMAIL?: string;
  /** Injected by the OAuth provider into the default handler's env. */
  OAUTH_PROVIDER: OAuthHelpers;
}

declare global {
  interface Env extends AuthEnv {}
  namespace Cloudflare {
    interface Env extends AuthEnv {}
  }
}
