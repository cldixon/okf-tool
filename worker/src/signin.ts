import type { Context, Hono } from "hono";
import { type SignupMode, signupMode, type User } from "./accounts";
import type { Deps } from "./app";
import { LEGAL } from "./legal";
import { mailKey, sendNow } from "./mail-queue";
import { alertNotice, esc, invalid, messagePage, PAGE_HEADERS, page } from "./oauth/pages";
import { fromThisSite } from "./origin";
import {
  clearedSessionCookie,
  LINK_MINUTES,
  newCode,
  readCookie,
  SESSION_COOKIE,
  safeNext,
  sessionCookie,
} from "./session";
import type { Found } from "./tenancy";

/**
 * Sign-in for the UI (v2 spec: Accounts and sign-in): email magic links, each with a code to type
 * on the device that asked (TEMPRA-188), and session cookies.
 * Who may get a link is the deployment's SIGNUP mode (v2 spec: A4): open, invite or closed.
 */

export interface Mailer {
  send(msg: {
    to: string;
    subject: string;
    text: string;
    /** Minimal HTML beside the text (notification mail). */
    html?: string;
    /** Extra headers: List-Unsubscribe and List-Unsubscribe-Post. */
    headers?: Record<string, string>;
  }): Promise<void>;
}

type AppEnv = { Bindings: Cloudflare.Env };
type C = Context<AppEnv>;

function isLoopback(url: URL): boolean {
  return ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
}

/** Local dev and the gate: no mail provider, links shown on the page and logged. */
export function devSignIn(req: Request, env: Cloudflare.Env): boolean {
  return env.DEV_SIGNIN === "1" && isLoopback(new URL(req.url));
}

/**
 * The signed-in user, or the response to send instead: a redirect to the sign-in page for a
 * page load, a 401 page for anything else.
 */
export async function signedIn(
  req: Request,
  deps: Pick<Deps, "accounts" | "sessions">,
): Promise<User | Response> {
  const secret = readCookie(req, SESSION_COOKIE);
  if (secret) {
    const user = await deps.sessions.user(secret);
    if (user) return user;
  }
  return notSignedIn(req);
}

/**
 * `signedIn` for a library's page, image or download (TEMPRA-201): the person, with the library
 * {owner}/{slug} and their membership found in the same D1 query (`Sessions.access`), for
 * `authorizeLibrary` to decide on.
 */
export async function signedInTo(
  req: Request,
  deps: Pick<Deps, "sessions">,
  owner: string,
  slug: string,
): Promise<{ user: User; found: Found } | Response> {
  const secret = readCookie(req, SESSION_COOKIE);
  const got = secret ? await deps.sessions.access(secret, owner, slug) : null;
  return got ? { user: got.user, found: got } : notSignedIn(req);
}

/** No session: the sign-in page for a page load, a 401 page for anything else. */
function notSignedIn(req: Request): Response {
  const url = new URL(req.url);
  if (req.method === "GET" || req.method === "HEAD") {
    const next = encodeURIComponent(url.pathname + url.search);
    return new Response(null, {
      status: 302,
      headers: { Location: `/sign-in?next=${next}`, "Cache-Control": "no-store" },
    });
  }
  return messagePage("Not signed in", "Sign in again, then retry.", 401, SIGN_IN);
}

/**
 * Sends a link by email, or in local dev (no mailer, DEV_SIGNIN=1, loopback) logs it and returns
 * the link, to show on the page. Returns "" once mailed, or null when sending failed.
 */
export async function sendLink(
  req: Request,
  env: Cloudflare.Env,
  d: Pick<Deps, "mailer" | "meter">,
  msg: { to: string; subject: string; text: string; html?: string; link: string },
): Promise<string | null> {
  // Local dev shows the link even when a mailer is bound, so nothing real is sent from cf dev.
  if (!d.mailer || devSignIn(req, env)) {
    if (!devSignIn(req, env)) return null;
    console.log(`Link for ${msg.to}: ${msg.link}`);
    return msg.link;
  }
  try {
    // Not queued (TEMPRA-89): the person is waiting on the page, which must say at once when the
    // link could not be sent. One retry after a short pause covers a passing failure.
    await sendNow(d.mailer, { to: msg.to, subject: msg.subject, text: msg.text, html: msg.html });
    d.meter?.({ kind: "email", account: msg.to });
    return "";
  } catch (e) {
    console.error(JSON.stringify({ mail_failed: msg.subject, error: String(e) }));
    return null;
  }
}

/**
 * Runs work after the response when the platform allows (so the sign-in page answers in the
 * same time whatever the email is), otherwise now. Failures are logged, never shown.
 */
function afterResponse(c: C, work: Promise<unknown>) {
  const logged = work.catch((e) => console.error(JSON.stringify({ after_response: String(e) })));
  try {
    c.executionCtx.waitUntil(logged);
  } catch {
    // No execution context (tests): the promise already runs; nothing waits on it.
  }
}

/** The operator's email (Worker secret OPERATOR_EMAIL), normalized like sign-in emails. */
export const operatorEmail = (env: Cloudflare.Env) =>
  env.OPERATOR_EMAIL?.trim().toLowerCase() || null;

/** Tells the operator a new email joined the waitlist (v2 spec: Accounts, The waitlist). */
async function notifyOperator(env: Cloudflare.Env, d: Deps, email: string, origin: string) {
  const to = operatorEmail(env);
  if (!to || !d.outbox) return;
  await d.outbox.send({
    key: mailKey("waitlist-notice", email),
    kind: "operator",
    account: to,
    to,
    subject: `Tempra waitlist: ${email}`,
    text: `${email} asked to join Tempra.\n\nApprove or dismiss: ${origin}/waitlist\n`,
  });
}

/** A server-rendered page with the strict headers sign-in uses: no script, no framing, no cache. */
export function html(
  body: string,
  status = 200,
  headers: Record<string, string> = {},
  title = "Sign in",
): Response {
  return new Response(page(title, body), { status, headers: { ...PAGE_HEADERS, ...headers } });
}

function sameOrigin(c: C): boolean {
  return fromThisSite(c.req.raw);
}

export const EMAIL = /^[^\s@]+@[^\s@]+$/;

const SIGN_IN = { href: "/sign-in", label: "Go to sign in" };

/** Said wherever a link may not have been sent: the link limits per email and per IP. */
const RATE_HINT = "If you asked several times, wait an hour, then try again.";

/**
 * The one way in (TEMPRA-284, tempra-dev `decisions/one-way-in.md`): "Join Tempra" behind every
 * "Join now", for signing in and joining the waitlist alike; "Sign in" only while closed, when
 * nobody new can join. Its title, lead and button by mode.
 */
function wayIn(mode: SignupMode): { title: string; lead: string; button: string } {
  if (mode === "closed") {
    return {
      title: "Sign in",
      lead: "We'll email you a link and a code. Tempra is not taking new accounts.",
      button: "Email me a link",
    };
  }
  return {
    title: "Join Tempra",
    lead:
      mode === "open"
        ? "We'll email you a link and a code. New here? The same link creates your account."
        : "Already in? We'll email you a sign-in link. New here? We'll add you to the list.",
    button: "Join now",
  };
}

function signInForm(next: string, mode: SignupMode, opts: { email?: string; error?: string } = {}) {
  const err = opts.error ? alertNotice("email-error", opts.error) : "";
  const way = wayIn(mode);
  return `<h1>${way.title}</h1>
<p>${way.lead}</p>
${err}<form method="post" action="/sign-in" class="stack">
<input type="hidden" name="next" value="${esc(next)}">
<label class="field">Email
<input id="email" name="email" type="text" inputmode="email" autocomplete="email" autocapitalize="off" spellcheck="false" required autofocus value="${esc(opts.email ?? "")}"${invalid("email-error", !!opts.error)}></label>
<p><button class="primary" type="submit">${way.button}</button></p></form>`;
}

const notSetUp = () =>
  html(
    `<h1>Sign-in is not set up</h1><p>This deployment has no way to send sign-in emails yet.</p>`,
    503,
    {},
    "Sign-in is not set up",
  );

/** The email from the sign-in form, normalized, and whether it looks like one. */
function formEmail(form: FormData): { email: string; ok: boolean } {
  const email = String(form.get("email") ?? "")
    .trim()
    .toLowerCase();
  return { email, ok: EMAIL.test(email) && email.length <= 254 };
}

/** Local dev: the link (and its code) shown on the page instead of mailed. */
const devLink = (shown: string, code?: string) =>
  shown
    ? `<p>Local dev, no email sent: <a id="dev-link" href="${esc(shown)}">link</a>${
        code ? `, code <code id="dev-code">${esc(code)}</code>` : ""
      }</p>`
    : "";

/**
 * The sign-in email (TEMPRA-188): the code in the subject, so it reads from a notification; the
 * HTML part has "Sign in to Tempra" as a link drawn as a button and the code large in mono (mail
 * clients take only inline styles), the text part the link and the code.
 */
export function signInMail(link: string, code: string | null) {
  const shown = code;
  const lasts = `It works once, within ${LINK_MINUTES} minutes. If you did not ask for it, ignore this email.`;
  const subject = shown ? `Tempra sign-in code: ${shown}` : "Your Tempra sign-in link";
  const text = shown
    ? `Sign in to Tempra:\n\n${link}\n\nOr enter this code on the page that asked for it:\n\n${shown}\n\n${lasts}\n`
    : `Open this link to sign in to Tempra:\n\n${link}\n\n${lasts}\n`;
  const font =
    "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Inter,Helvetica,Arial,sans-serif";
  const html = `<div style="${font};color:#111;font-size:15px;line-height:1.5">
<p style="margin:0 0 20px"><a href="${esc(link)}" style="display:inline-block;padding:10px 18px;border-radius:999px;background:#111;color:#fff;text-decoration:none;font-weight:600">Sign in to Tempra</a></p>${
    shown
      ? `
<p style="margin:0 0 8px;color:#555">Or enter this code on the page that asked for it:</p>
<p style="margin:0 0 20px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:28px;font-weight:600;letter-spacing:4px">${esc(shown)}</p>`
      : ""
  }
<p style="margin:0;color:#555;font-size:13px">${esc(lasts)}</p>
</div>`;
  return { subject, text, html };
}

/**
 * Creates and sends a sign-in link and its code, within the per-email and per-IP limits. The dev
 * link to show (and its code), "" when mailed or when over a limit (the page says the same either
 * way), null when sending failed.
 */
async function mailSignInLink(
  c: C,
  d: Deps,
  email: string,
  next: string,
): Promise<{ shown: string; code?: string } | null> {
  const code = newCode();
  const ip = c.req.header("CF-Connecting-IP") ?? null;
  const secret = await d.sessions.createLink(email, ip, null, code);
  if (!secret) return { shown: "" };
  const link = `${new URL(c.req.url).origin}/sign-in/link?t=${secret}&next=${encodeURIComponent(next)}`;
  const shown = await sendLink(c.req.raw, c.env, d, {
    to: email,
    link,
    ...signInMail(link, code),
  });
  return shown === null ? null : { shown, code: shown ? code : undefined };
}

/**
 * "Check your email" after `/sign-in`: what was sent, and the code field (TEMPRA-188), the email
 * carried in the form, for finishing here when the email is read on another device. Under
 * `invite` its words cover a sign-in link and the waitlist's note alike, so it never says which
 * (TEMPRA-284).
 */
function checkEmail(
  email: string,
  next: string,
  mode: SignupMode,
  opts: { error?: string; shown?: string; code?: string } = {},
) {
  const to = `<strong>${esc(email)}</strong>`;
  const lead =
    mode === "open"
      ? `A link and a code are on their way to ${to}. Open the link, or enter the code here.`
      : mode === "invite"
        ? `We've emailed ${to} a sign-in link and a code or, if it's new here, a note that it's on the list. To sign in, open the link or enter the code here.`
        : `If ${to} can sign in here, a link and a code are on their way. Open the link, or enter the code here.`;
  const err = opts.error ? alertNotice("code-error", opts.error) : "";
  return `<h1>Check your email</h1>
<p>${lead} Either works once, within ${LINK_MINUTES} minutes.</p>
${err}<form method="post" action="/sign-in/code" class="stack">
<input type="hidden" name="email" value="${esc(email)}"><input type="hidden" name="next" value="${esc(next)}">
<label class="field">Code
<input id="code" name="code" type="text" autocomplete="one-time-code" autocapitalize="characters" spellcheck="false" maxlength="12" required autofocus${invalid("code-error", !!opts.error)}></label>
<p><button class="primary" type="submit">Continue</button></p></form>
<p class="muted">Nothing? Check spam. ${RATE_HINT} <a href="/sign-in?next=${esc(encodeURIComponent(next))}">Try another email</a>.</p>${devLink(opts.shown ?? "", opts.code)}`;
}

const couldNotSend = (back: string) =>
  html(
    `<h1>Could not send email</h1><p>Try again in a few minutes.</p><p><a href="${esc(back)}">Back</a></p>`,
    502,
    {},
    "Could not send email",
  );

/**
 * Puts a new email on the waitlist (TEMPRA-125): tells it so, once, and the operator (at most 10
 * a day). Run after the response.
 */
async function joinWaitlist(c: C, d: Deps, email: string) {
  const joined = await d.accounts.joinWaitlist(email, c.req.header("CF-Connecting-IP") ?? null);
  if (joined.added) await welcomeToWaitlist(c, d, email);
  if (joined.notify) await notifyOperator(c.env, d, email, new URL(c.req.url).origin);
}

/** Tells a new waitlisted email it is on the list, once (TEMPRA-125). */
async function welcomeToWaitlist(c: C, d: Deps, email: string) {
  const text = `Thanks for asking to join Tempra. You're on the list, and we'll email this address when you're in.\n\nIf you did not ask, ignore this email.\n`;
  if (!d.outbox || devSignIn(c.req.raw, c.env)) {
    if (devSignIn(c.req.raw, c.env)) console.log(`Waitlist email for ${email}`);
    return;
  }
  await d.outbox.send({
    key: mailKey("waitlist-welcome", email),
    kind: "waitlist",
    account: email,
    to: email,
    subject: "You're on the list: Tempra",
    text,
  });
}

/**
 * After a link or a code was used up: checked again (an invite may have been withdrawn since it
 * was sent), the account made the first time, and a session started.
 */
async function finishSignIn(c: C, d: Deps, email: string, next: string): Promise<Response> {
  const mode = signupMode(c.env.SIGNUP);
  if (!(await d.accounts.mayJoin(email, mode))) {
    const onward =
      mode === "invite" ? `<a href="/sign-in">Join now</a>` : `<a href="${LEGAL}">About Tempra</a>`;
    return html(
      `<h1>Not invited</h1><p>This address cannot sign in yet.</p><p>${onward}</p>`,
      403,
      {},
      "Not invited",
    );
  }
  const user = await d.accounts.user(email);
  const secret = await d.sessions.create(user.id, c.req.header("User-Agent") ?? null);
  return new Response(null, {
    status: 303,
    headers: { Location: next, "Set-Cookie": sessionCookie(secret), "Cache-Control": "no-store" },
  });
}

export function registerSignInRoutes<E extends AppEnv>(
  app: Hono<E>,
  deps: (env: Cloudflare.Env) => Deps,
) {
  const unavailable = (c: C) => !deps(c.env).mailer && !devSignIn(c.req.raw, c.env);

  app.get("/sign-in", async (c) => {
    const next = safeNext(c.req.query("next"));
    const secret = readCookie(c.req.raw, SESSION_COOKIE);
    if (secret && (await deps(c.env).sessions.user(secret))) return c.redirect(next, 302);
    if (unavailable(c as unknown as C)) return notSetUp();
    const mode = signupMode(c.env.SIGNUP);
    return html(signInForm(next, mode), 200, {}, wayIn(mode).title);
  });

  // The one way in (TEMPRA-284): the server decides what the email gets, and the page answers the
  // same whatever it decided. A post to /request-access, from an old form, is this one.
  const join = async (c: C) => {
    if (!sameOrigin(c)) return messagePage("Refused", "Sign in from this site.", 403, SIGN_IN);
    const d = deps(c.env);
    const form = await c.req.formData();
    const next = safeNext(String(form.get("next") ?? ""));
    const mode = signupMode(c.env.SIGNUP);
    const { email, ok } = formEmail(form);
    if (!ok) {
      return html(
        signInForm(next, mode, { email, error: "That does not look like an email address." }),
        400,
        {},
        wayIn(mode).title,
      );
    }
    if (unavailable(c)) return notSetUp();
    let sent: { shown: string; code?: string } = { shown: "" };
    if (await d.accounts.mayJoin(email, mode)) {
      const mailed = await mailSignInLink(c, d, email, next);
      if (mailed === null) return couldNotSend(`/sign-in?next=${encodeURIComponent(next)}`);
      sent = mailed;
    } else if (mode === "invite") {
      // After the response, so joining adds no time to the page whatever the address is.
      afterResponse(c, joinWaitlist(c, d, email));
    }
    // The same answer whether the email has an account, is invited, is new, or asked too often:
    // the page reveals none of it.
    return html(checkEmail(email, next, mode, sent), 200, {}, "Check your email");
  };
  app.post("/sign-in", (c) => join(c as unknown as C));

  // The code from the email, typed on the device that asked (TEMPRA-188). A wrong code answers
  // the same page whatever the email is; the store counts it against the email's live codes.
  app.post("/sign-in/code", async (c) => {
    if (!sameOrigin(c as unknown as C))
      return messagePage("Refused", "Sign in from this site.", 403, SIGN_IN);
    const d = deps(c.env);
    const form = await c.req.formData();
    const next = safeNext(String(form.get("next") ?? ""));
    const { email, ok } = formEmail(form);
    if (!ok) return c.redirect(`/sign-in?next=${encodeURIComponent(next)}`, 303);
    const used = await d.sessions.consumeCode(email, String(form.get("code") ?? ""));
    if (!used) {
      return html(
        checkEmail(email, next, signupMode(c.env.SIGNUP), {
          error: "That code didn't work. Check it, or open the link in the email.",
        }),
        400,
        {},
        "Check your email",
      );
    }
    return finishSignIn(c as unknown as C, d, used.email, next);
  });

  // Request access (TEMPRA-125) became the one way in (TEMPRA-284): its old links and forms land
  // there.
  app.get("/request-access", (c) => {
    const next = c.req.query("next");
    const to = next ? `/sign-in?next=${encodeURIComponent(safeNext(next))}` : "/sign-in";
    return new Response(null, {
      status: 302,
      headers: { Location: to, "Cache-Control": "no-store" },
    });
  });
  app.post("/request-access", (c) => join(c as unknown as C));

  // Opening the link only shows a button: mail scanners that fetch links cannot use it up.
  app.get("/sign-in/link", (c) => {
    const t = c.req.query("t") ?? "";
    const next = safeNext(c.req.query("next"));
    return html(`<h1>Sign in</h1><p>Continue to finish signing in on this device.</p>
<form method="post" action="/sign-in/link">
<input type="hidden" name="t" value="${esc(t)}"><input type="hidden" name="next" value="${esc(next)}">
<p><button class="primary" type="submit">Continue</button></p></form>`);
  });

  app.post("/sign-in/link", async (c) => {
    if (!sameOrigin(c as unknown as C))
      return messagePage("Refused", "Sign in from this site.", 403, SIGN_IN);
    const d = deps(c.env);
    const form = await c.req.formData();
    const next = safeNext(String(form.get("next") ?? ""));
    const email = (await d.sessions.consumeLink(String(form.get("t") ?? "")))?.email;
    if (!email) {
      return html(
        `<h1>This link has expired or was already used</h1><p>Sign-in links work once, within ${LINK_MINUTES} minutes.</p><p><a href="/sign-in?next=${esc(encodeURIComponent(next))}">Get a new link</a></p>`,
        400,
        {},
        "Link expired",
      );
    }
    return finishSignIn(c as unknown as C, d, email, next);
  });

  const signOut = async (c: C, everywhere: boolean) => {
    if (!sameOrigin(c)) return messagePage("Refused", "Sign out from this site.", 403);
    // Where to come back to after signing in again (consent's "Not you? Sign out").
    const form = await c.req.formData().catch(() => null);
    const next = safeNext(String(form?.get("next") ?? ""));
    const d = deps(c.env);
    const secret = readCookie(c.req.raw, SESSION_COOKIE);
    if (secret) {
      const user = everywhere ? await d.sessions.user(secret) : null;
      if (user) await d.sessions.endAll(user.id);
      else await d.sessions.end(secret);
    }
    return new Response(null, {
      status: 303,
      headers: {
        Location: next === "/" ? "/sign-in" : `/sign-in?next=${encodeURIComponent(next)}`,
        "Set-Cookie": clearedSessionCookie,
      },
    });
  };
  app.post("/sign-out", (c) => signOut(c as unknown as C, false));
  app.post("/sign-out/everywhere", (c) => signOut(c as unknown as C, true));
}
