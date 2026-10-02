import type { Context, Hono } from "hono";
import { accessIdentity } from "./access";
import type { User } from "./accounts";
import type { Deps } from "./app";
import { esc, messagePage, page } from "./oauth/pages";
import {
  clearedSessionCookie,
  LINK_MINUTES,
  readCookie,
  SESSION_COOKIE,
  safeNext,
  sessionCookie,
} from "./session";

/**
 * Sign-in for /app/* (v2 spec: Accounts and sign-in): email magic links and session cookies.
 * Until the A4 cut-over, a deployment that still has Cloudflare Access configured also accepts
 * a valid Access sign-in, so the live v1 deployment keeps working.
 */

export interface Mailer {
  send(msg: { to: string; subject: string; text: string }): Promise<void>;
}

type AppEnv = { Bindings: Cloudflare.Env };
type C = Context<AppEnv>;

function isLoopback(url: URL): boolean {
  return ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
}

/** Local dev and the gate: no mail provider, links shown on the page and logged. */
function devSignIn(req: Request, env: Cloudflare.Env): boolean {
  return env.DEV_SIGNIN === "1" && isLoopback(new URL(req.url));
}

/**
 * The signed-in user, or the response to send instead: a redirect to the sign-in page for a
 * page load, a 401 page for anything else.
 */
export async function signedIn(
  req: Request,
  env: Cloudflare.Env,
  deps: Pick<Deps, "accounts" | "sessions">,
): Promise<User | Response> {
  const secret = readCookie(req, SESSION_COOKIE);
  if (secret) {
    const user = await deps.sessions.user(secret);
    if (user) return user;
  }
  if (env.ACCESS_TEAM_DOMAIN) {
    const access = await accessIdentity(req, {
      teamDomain: env.ACCESS_TEAM_DOMAIN,
      audience: env.ACCESS_AUD,
    });
    if (access.ok) return deps.accounts.user(access.identity.email);
  }
  const url = new URL(req.url);
  if (req.method === "GET" || req.method === "HEAD") {
    const next = encodeURIComponent(url.pathname + url.search);
    return new Response(null, {
      status: 302,
      headers: { Location: `/app/sign-in?next=${next}`, "Cache-Control": "no-store" },
    });
  }
  return messagePage("Not signed in", "Sign in again, then retry.", 401);
}

function html(body: string, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(page("Sign in", body), {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "X-Frame-Options": "DENY",
      "Content-Security-Policy": "default-src 'none'; form-action 'self'; frame-ancestors 'none'",
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      ...headers,
    },
  });
}

function sameOrigin(c: C): boolean {
  return c.req.header("Origin") === new URL(c.req.url).origin;
}

const EMAIL = /^[^\s@]+@[^\s@]+$/;

function signInForm(next: string, opts: { email?: string; error?: string } = {}) {
  const err = opts.error ? `<p><strong>${esc(opts.error)}</strong></p>` : "";
  return `<h1>Sign in to OKF</h1>
<p>We email you a link. New here? The same link creates your account.</p>
${err}<form method="post" action="/app/sign-in">
<input type="hidden" name="next" value="${esc(next)}">
<p><label for="email">Email</label>
<input id="email" name="email" type="text" inputmode="email" autocomplete="email" required value="${esc(opts.email ?? "")}"></p>
<p><button type="submit">Email me a link</button></p></form>`;
}

export function registerSignInRoutes<E extends AppEnv>(
  app: Hono<E>,
  deps: (env: Cloudflare.Env) => Deps,
) {
  const unavailable = (c: C) => !deps(c.env).mailer && !devSignIn(c.req.raw, c.env);

  app.get("/app/sign-in", async (c) => {
    const next = safeNext(c.req.query("next"));
    const secret = readCookie(c.req.raw, SESSION_COOKIE);
    if (secret && (await deps(c.env).sessions.user(secret))) return c.redirect(next, 302);
    if (unavailable(c as unknown as C)) {
      return html(
        `<h1>Sign-in is not set up</h1><p>This deployment has no way to send sign-in emails yet.</p>`,
        503,
      );
    }
    return html(signInForm(next));
  });

  app.post("/app/sign-in", async (c) => {
    if (!sameOrigin(c as unknown as C))
      return messagePage("Refused", "Sign in from this site.", 403);
    const d = deps(c.env);
    const form = await c.req.formData();
    const next = safeNext(String(form.get("next") ?? ""));
    const email = String(form.get("email") ?? "")
      .trim()
      .toLowerCase();
    if (!EMAIL.test(email) || email.length > 254) {
      return html(
        signInForm(next, { email, error: "That does not look like an email address." }),
        400,
      );
    }
    const dev = devSignIn(c.req.raw, c.env);
    if (!d.mailer && !dev) {
      return html(`<h1>Sign-in is not set up</h1><p>This deployment cannot send email.</p>`, 503);
    }
    const ip = c.req.header("CF-Connecting-IP") ?? null;
    const secret = await d.sessions.createLink(email, ip);
    let shown = "";
    if (secret) {
      const origin = new URL(c.req.url).origin;
      const link = `${origin}/app/sign-in/link?t=${secret}&next=${encodeURIComponent(next)}`;
      if (d.mailer) {
        await d.mailer.send({
          to: email,
          subject: "Your OKF sign-in link",
          text: `Open this link to sign in to OKF:\n\n${link}\n\nIt works once, within ${LINK_MINUTES} minutes. If you did not ask for it, ignore this email.\n`,
        });
      } else {
        console.log(`Sign-in link for ${email}: ${link}`);
        shown = `<p>Local dev, no email sent: <a id="dev-link" href="${esc(link)}">sign-in link</a></p>`;
      }
    }
    // The same answer whether or not the email has an account, or has asked too often.
    return html(`<h1>Check your email</h1>
<p>If <strong>${esc(email)}</strong> can sign in here, a link is on its way. It works once, within ${LINK_MINUTES} minutes.</p>
<p>Nothing? Check spam, or <a href="/app/sign-in?next=${esc(encodeURIComponent(next))}">try again</a> later.</p>${shown}`);
  });

  // Opening the link only shows a button: mail scanners that fetch links cannot use it up.
  app.get("/app/sign-in/link", (c) => {
    const t = c.req.query("t") ?? "";
    const next = safeNext(c.req.query("next"));
    return html(`<h1>Sign in to OKF</h1><p>Continue to finish signing in on this device.</p>
<form method="post" action="/app/sign-in/link">
<input type="hidden" name="t" value="${esc(t)}"><input type="hidden" name="next" value="${esc(next)}">
<p><button type="submit">Continue</button></p></form>`);
  });

  app.post("/app/sign-in/link", async (c) => {
    if (!sameOrigin(c as unknown as C))
      return messagePage("Refused", "Sign in from this site.", 403);
    const d = deps(c.env);
    const form = await c.req.formData();
    const next = safeNext(String(form.get("next") ?? ""));
    const email = await d.sessions.consumeLink(String(form.get("t") ?? ""));
    if (!email) {
      return html(
        `<h1>This link has expired</h1><p>Sign-in links work once, within ${LINK_MINUTES} minutes.</p><p><a href="/app/sign-in?next=${esc(encodeURIComponent(next))}">Get a new link</a></p>`,
        400,
      );
    }
    const user = await d.accounts.user(email);
    const secret = await d.sessions.create(user.id, c.req.header("User-Agent") ?? null);
    return new Response(null, {
      status: 303,
      headers: { Location: next, "Set-Cookie": sessionCookie(secret), "Cache-Control": "no-store" },
    });
  });

  const signOut = async (c: C, everywhere: boolean) => {
    if (!sameOrigin(c)) return messagePage("Refused", "Sign out from this site.", 403);
    const d = deps(c.env);
    const secret = readCookie(c.req.raw, SESSION_COOKIE);
    if (secret) {
      const user = everywhere ? await d.sessions.user(secret) : null;
      if (user) await d.sessions.endAll(user.id);
      else await d.sessions.end(secret);
    }
    return new Response(null, {
      status: 303,
      headers: { Location: "/app/sign-in", "Set-Cookie": clearedSessionCookie },
    });
  };
  app.post("/app/sign-out", (c) => signOut(c as unknown as C, false));
  app.post("/app/sign-out/everywhere", (c) => signOut(c as unknown as C, true));
}
