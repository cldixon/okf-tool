import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";

/** Secrets and injected helpers that `cf workers types` does not know about (they are not in cloudflare.config.ts). */
interface AuthEnv {
  /**
   * The Access team domain, e.g. https://<team>.cloudflareaccess.com (secret). Until the v2 A4
   * cut-over, an Access sign-in is accepted on /app/* alongside magic-link sessions.
   */
  ACCESS_TEAM_DOMAIN?: string;
  /** The audience tag of the Access application covering /app/* (secret). */
  ACCESS_AUD?: string;
  /** Local dev and the gate: "1" shows sign-in links on the page (loopback hosts only). */
  DEV_SIGNIN?: string;
  /** Injected by the OAuth provider into the default handler's env. */
  OAUTH_PROVIDER: OAuthHelpers;
}

declare global {
  interface Env extends AuthEnv {}
  namespace Cloudflare {
    interface Env extends AuthEnv {}
  }
}
