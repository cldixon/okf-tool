import type { Hono } from "hono";
import type { Deps } from "./app";
import { esc, messagePage } from "./oauth/pages";
import { sendInvitation } from "./operator";
import { fromThisSite } from "./origin";
import { html, operatorEmail, signedIn } from "./signin";

/**
 * The operator's review of the waitlist (v2 spec: Accounts and sign-in, The waitlist): who asked
 * to join, with Approve and Dismiss. Only the session whose email is OPERATOR_EMAIL sees it;
 * everyone else gets 404. A server page, like sign-in: it works with no script. Where the
 * deployment has the operator's portal (ADMIN_ORIGIN, TEMPRA-278), it sends the operator there.
 */

type AppEnv = { Bindings: Cloudflare.Env };

const notFound = () => messagePage("Not found", "There is nothing here.", 404);
const WAITLIST = { href: "/waitlist", label: "Back to the waitlist" };

/**
 * What a decision did, as the page after it says it. The post redirects here (V-12), so a reload
 * shows the list again rather than deciding twice.
 */
const OUTCOMES: Record<string, (email: string) => string> = {
  approved: (e) => `${e} approved.`,
  dismissed: (e) => `${e} dismissed.`,
  missing: (e) => `${e} was not waiting.`,
  mail_failed: (e) => `${e} approved, but the email to them failed; tell them yourself.`,
  no_mail: (e) => `${e} approved. This deployment cannot send email; tell them yourself.`,
};

function reviewPage(entries: { email: string; created: string }[], done?: string): Response {
  const rows = entries
    .map(
      (e) => `<tr><td>${esc(e.email)}</td><td>${esc(e.created.slice(0, 10))}</td><td>
<form method="post" action="/waitlist"><input type="hidden" name="email" value="${esc(e.email)}">
<button type="submit" name="decision" value="invited" aria-label="Approve ${esc(e.email)}">Approve</button>
<button type="submit" name="decision" value="dismissed" aria-label="Dismiss ${esc(e.email)}">Dismiss</button></form></td></tr>`,
    )
    .join("\n");
  const list = entries.length
    ? `<table><thead><tr><th>Email</th><th>Asked</th><th>Decision</th></tr></thead><tbody>
${rows}
</tbody></table>`
    : "<p>Nobody is waiting.</p>";
  return html(
    `<h1>Waitlist</h1>${done ? `<p>${esc(done)}</p>` : ""}
<p>Approving invites the email and tells them they can sign in.</p>
${list}
<p><a href="/">Libraries</a></p>`,
    200,
    {},
    "Waitlist",
  );
}

export function registerWaitlistRoutes<E extends AppEnv>(
  app: Hono<E>,
  deps: (env: Cloudflare.Env) => Deps,
) {
  app.get("/waitlist", async (c) => {
    const d = deps(c.env);
    const user = await signedIn(c.req.raw, d);
    if (user instanceof Response) return user;
    if (user.email !== operatorEmail(c.env)) return notFound();
    const portal = (c.env as { ADMIN_ORIGIN?: string }).ADMIN_ORIGIN;
    if (portal) return c.redirect(`${portal}/`, 302);
    const outcome = OUTCOMES[c.req.query("done") ?? ""];
    const email = c.req.query("email") ?? "";
    return reviewPage(await d.accounts.waitlist(), outcome && email ? outcome(email) : undefined);
  });

  app.post("/waitlist", async (c) => {
    const d = deps(c.env);
    const user = await signedIn(c.req.raw, d);
    if (user instanceof Response) return user;
    if (user.email !== operatorEmail(c.env)) return notFound();
    if (!fromThisSite(c.req.raw)) return messagePage("Refused", "Decide from this site.", 403);
    const form = await c.req.formData();
    const email = String(form.get("email") ?? "");
    const decision = String(form.get("decision") ?? "");
    if (decision !== "invited" && decision !== "dismissed") {
      return messagePage("Bad request", "Approve or dismiss.", 400, WAITLIST);
    }
    const decided = await d.accounts.decideWaitlist(email, decision);
    let done: keyof typeof OUTCOMES = decided ? "dismissed" : "missing";
    if (decided && decision === "invited") {
      // Queued (TEMPRA-89): the operator is not waiting on it, and a retry should reach them.
      const mailed = await sendInvitation(d, email, new URL(c.req.url).origin, { asked: true });
      done = mailed === "sent" ? "approved" : mailed;
    }
    const q = new URLSearchParams({ done, email });
    return c.redirect(`/waitlist?${q}`, 303);
  });
}
