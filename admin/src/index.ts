import { type Context, Hono } from "hono";
import { fetchedKeys, type KeySource, verifyAccess } from "./access";
import { type Day, dailyActivity } from "./analytics";
import type { OperatorService } from "./operator";
import { home, isOutcome, message } from "./pages";

/**
 * The operator's portal (TEMPRA-278, tempra-dev `decisions/an-admin-portal.md`). Cloudflare Access
 * signs the operator in at the edge (one-time PIN, 2 hours); every request here checks Access's
 * token too and gets a 403 page without it. The work is the app's, through OPERATOR.
 */

export interface AdminEnv {
  ORIGIN: string;
  ACCESS_TEAM: string;
  ACCESS_AUD: string;
  USAGE_DATASET: string;
  ACCOUNT_ID: string;
  OPERATOR_EMAIL?: string;
  ANALYTICS_TOKEN?: string;
  OPERATOR?: OperatorService;
}

const HEADERS: Record<string, string> = {
  "Content-Security-Policy":
    "default-src 'none'; style-src 'self'; font-src 'self'; img-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  "Cache-Control": "no-store",
  "X-Robots-Tag": "noindex",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "same-origin",
};

type E = { Bindings: AdminEnv; Variables: { operator: string } };

const page = (html: string, status = 200) =>
  new Response(html, { status, headers: { "Content-Type": "text/html; charset=utf-8" } });

export function createAdmin(
  opts: { keys?: KeySource; fetcher?: typeof fetch; now?: () => Date } = {},
) {
  const keys = opts.keys ?? fetchedKeys();
  const app = new Hono<E>();

  app.use("*", async (c, next) => {
    const verdict = await verifyAccess(
      c.req.header("Cf-Access-Jwt-Assertion") ?? null,
      {
        team: c.env.ACCESS_TEAM,
        aud: c.env.ACCESS_AUD,
        operator: c.env.OPERATOR_EMAIL ?? "",
      },
      keys,
      (opts.now?.() ?? new Date()).getTime(),
    );
    if (!verdict.ok) {
      console.log(JSON.stringify({ access_refused: verdict.why }));
      c.res = page(message("Not allowed", "Sign in through Cloudflare Access."), 403);
    } else {
      c.set("operator", verdict.email);
      await next();
    }
    for (const [k, v] of Object.entries(HEADERS)) c.res.headers.set(k, v);
  });

  app.get("/", async (c) => {
    const op = c.env.OPERATOR;
    const who = c.get("operator");
    const fail = <T>(p: Promise<T> | undefined): Promise<T | null> =>
      (p ?? Promise.resolve(null)).catch((e) => {
        console.error(JSON.stringify({ operator_failed: String(e) }));
        return null;
      });
    const [people, activity, days] = await Promise.all([
      fail(op?.people(who)),
      fail(op?.activity(who)),
      fail<Day[] | null>(
        dailyActivity(
          {
            accountId: c.env.ACCOUNT_ID,
            token: c.env.ANALYTICS_TOKEN,
            dataset: c.env.USAGE_DATASET,
          },
          opts.fetcher,
          opts.now?.(),
        ),
      ),
    ]);
    const done = c.req.query("done");
    const email = c.req.query("email") ?? "";
    return page(
      home({
        people,
        activity,
        days,
        done: isOutcome(done) && email ? { outcome: done, email } : null,
      }),
    );
  });

  /** A post from this page only (Origin), then back to it with what happened (post, redirect, get). */
  const posted = async (
    c: Context<E>,
    run: (op: OperatorService, who: string, email: string, form: FormData) => Promise<string>,
  ) => {
    if (c.req.header("Origin") !== c.env.ORIGIN) {
      return page(message("Refused", "Send this from the portal's own page."), 403);
    }
    const op = c.env.OPERATOR;
    if (!op) return page(message("Unavailable", "The app is not bound here."), 503);
    const form = await c.req.formData();
    const email = String(form.get("email") ?? "").trim();
    const outcome = await run(op, c.get("operator"), email, form);
    return c.redirect(`/?${new URLSearchParams({ done: outcome, email })}`, 303);
  };

  app.post("/invite", (c) => posted(c, (op, who, email) => op.invite(who, email)));
  app.post("/decide", (c) =>
    posted(c, async (op, who, email, form) => {
      const decision = String(form.get("decision") ?? "");
      if (decision !== "invited" && decision !== "dismissed") return "missing";
      return op.decide(who, email, decision);
    }),
  );

  app.notFound(() => page(message("Not found", "There is nothing here."), 404));
  return app;
}

const admin = createAdmin();

export default {
  fetch: (request: Request, env: AdminEnv, ctx: ExecutionContext) => admin.fetch(request, env, ctx),
} satisfies ExportedHandler<AdminEnv>;
