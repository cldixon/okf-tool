import type { Context, Hono } from "hono";
import type { User } from "./accounts";
import type { Deps } from "./app";
import type { ItemKind, Notifications } from "./notify";
import { devOutbox, flushMail, itemLink } from "./notify-mail";
import { esc, messageBody, PAGE_HEADERS } from "./oauth/pages";
import { devSignIn, html } from "./signin";
import { StoreError } from "./store/errors";

/**
 * The person's inbox and mail settings (TEMPRA-72, TEMPRA-74), for a signed-in session only:
 * items addressed to them across their libraries, read and done, and what they are mailed. The
 * one-click unsubscribe is open to anyone holding the link's key, from any site, as RFC 8058
 * asks; the dev outbox exists only in local dev.
 */
// biome-ignore lint/suspicious/noExplicitAny: the app's env type is generic here.
type C = Context<any>;

export function notificationsOf(d: Deps): Notifications {
  if (!d.notifications)
    throw new StoreError(501, "unavailable", "Notifications are not wired here.");
  return d.notifications;
}

/** What an open item lets the person do from the Inbox (TEMPRA-116). */
export function itemActions(kind: ItemKind): string[] {
  switch (kind) {
    case "reply":
      return ["reply", "resolve"];
    case "mention":
      return ["reply"];
    case "invitation":
      return ["accept", "decline"];
    default:
      return ["open"];
  }
}

export function registerInboxApi(
  // biome-ignore lint/suspicious/noExplicitAny: mounted on the app whatever its env.
  app: Hono<any>,
  deps: (env: Cloudflare.Env) => Deps,
  signedIn: (c: C, d: Deps) => Promise<User>,
) {
  const person = async (c: C) => {
    const d = deps(c.env);
    if (c.req.header("Authorization") !== undefined) {
      throw new StoreError(403, "session_only", "The inbox is read only from the app's pages.");
    }
    const user = await signedIn(c, d);
    return { d, n: notificationsOf(d), user };
  };
  const body = async <T>(c: C): Promise<Partial<T>> =>
    (await c.req.json<T>().catch(() => ({}))) as Partial<T>;

  // ------------------------------------------------------------------ the inbox

  /** A library by {owner}/{slug}, among those the person reaches; 404 otherwise. */
  const reachableNamed = async (d: Deps, user: User, name: string) => {
    const lib = (await d.accounts.reachable(user.id)).find((l) => `${l.owner}/${l.slug}` === name);
    if (!lib) throw new StoreError(404, "no_library", `There is no library ${name}.`);
    return lib;
  };

  // The Inbox (TEMPRA-116, TEMPRA-189): open items, `?done=1` done ones (its Earlier list),
  // `?all=1` both; `?library=<owner>/<slug>` one library's. Each item says what the Inbox draws: its library's
  // name and title, the page's title, who did it (an agent by its name) and the actions it takes.
  app.get("/api/v1/inbox", async (c) => {
    const { d, n, user } = await person(c);
    const limit = Number(c.req.query("limit") ?? "") || undefined;
    const named = c.req.query("library");
    const [libs, filter] = await Promise.all([
      d.accounts.reachable(user.id),
      named ? reachableNamed(d, user, named) : Promise.resolve(null),
    ]);
    const page = await n.inbox(user.id, {
      all: c.req.query("all") === "1",
      done: c.req.query("done") === "1",
      library: filter?.id,
      before: c.req.query("before") || undefined,
      limit,
    });
    const byId = new Map(libs.map((l) => [l.id, l]));
    const agentIds = [...new Set(page.items.flatMap((i) => (i.by_agent ? [i.by_agent] : [])))];
    const [agents, invitations] = await Promise.all([
      agentIds.length ? d.accounts.agents(agentIds) : Promise.resolve([]),
      page.items.some((i) => i.kind === "invitation" && i.done_at === null)
        ? d.accounts.invitations(user.id)
        : Promise.resolve([]),
    ]);
    const agentName = new Map(agents.map((a) => [a.id, a.name]));
    const invitation = new Map(invitations.map((v) => [`${v.owner}/${v.slug}`, v.id]));
    return c.json({
      items: page.items.map(({ library, by_user: _u, by_agent, ...i }) => {
        const lib = library ? byId.get(library) : undefined;
        const agent = by_agent ? (agentName.get(by_agent) ?? null) : null;
        return {
          ...i,
          // Where it is now (a renamed handle), or where it happened; "" for the account's own
          // notices (`quota`, TEMPRA-232).
          library: lib ? `${lib.owner}/${lib.slug}` : i.place,
          library_title: lib?.title || null,
          who: agent ?? (by_agent ? i.actor : i.actor.replace(/^human:/, "")),
          // Tempra's own notices (`quota`) are no agent's.
          agent: i.kind !== "quota" && (by_agent !== null || !i.actor.startsWith("human:")),
          invitation: i.kind === "invitation" ? (invitation.get(i.place) ?? null) : null,
          actions: i.done_at === null ? itemActions(i.kind) : [],
          href: itemLink("", { ...i, place: lib ? `${lib.owner}/${lib.slug}` : i.place }),
        };
      }),
      next: page.next,
      open: page.open,
    });
  });

  // The bell's count: what waits (one state, TEMPRA-189); cheap enough to ask on every page.
  app.get("/api/v1/inbox/count", async (c) => {
    const { n, user } = await person(c);
    return c.json({ open: await n.openCount(user.id) });
  });

  // Done: the person opened the item (or, by hand, set it aside).
  app.post("/api/v1/inbox/:id/done", async (c) => {
    const { n, user } = await person(c);
    const b = await body<{ done: unknown }>(c);
    const ok = await n.markDone(user.id, c.req.param("id"), b.done !== false);
    if (!ok) throw new StoreError(404, "not_found", "No such item in your inbox.");
    return c.json({ done: b.done !== false });
  });

  // ------------------------------------------------------------------ mail settings

  // One switch (TEMPRA-189): mentions and replies by email, or not. Invitations always mail.
  app.get("/api/v1/account/notifications", async (c) => {
    const { n, user } = await person(c);
    return c.json(await n.prefs(user.id));
  });

  app.put("/api/v1/account/notifications", async (c) => {
    const { n, user } = await person(c);
    const b = await body<{ email: unknown }>(c);
    if (typeof b.email !== "boolean") {
      throw new StoreError(400, "bad_request", "Send { email: true } or { email: false }.");
    }
    await n.setPrefs(user.id, { email: b.email });
    return c.body(null, 204);
  });

  // ------------------------------------------------------------------ one-click unsubscribe

  const unsubscribed = () =>
    html(
      messageBody(
        "Unsubscribed",
        "You get no more notification email from Tempra. Turn it back on in the Email section of your Account page.",
        { href: "/account#email", label: "Go to your account" },
      ),
      200,
      {},
      "Unsubscribed",
    );
  const badKey = () =>
    html(
      messageBody("Link not valid", "Change what you are mailed from your Account page.", {
        href: "/account#email",
        label: "Go to your account",
      }),
      404,
      {},
      "Unsubscribe",
    );

  // A mail client or scanner may fetch the link: the GET only asks, the POST does it.
  app.get("/unsubscribe", async (c) => {
    const key = c.req.query("k") ?? "";
    if (!/^[0-9a-f]{48}$/.test(key)) return badKey();
    return html(
      `<h1>Unsubscribe</h1><p class="public-lead">Stop all notification mail from Tempra?</p>
<form method="post" action="/unsubscribe?k=${esc(key)}"><p><button class="primary" type="submit">Unsubscribe</button></p></form>`,
      200,
      {},
      "Unsubscribe",
    );
  });

  // RFC 8058: the mail provider posts here, from its own site, with no session. The key is the
  // credential, and all it can do is turn mail off.
  app.post("/unsubscribe", async (c) => {
    const n = notificationsOf(deps(c.env));
    const user = await n.unsubscribe(c.req.query("k") ?? "");
    return user ? unsubscribed() : badKey();
  });

  // ------------------------------------------------------------------ local dev outbox

  const devOnly = (c: C) => {
    if (!devSignIn(c.req.raw, c.env)) throw new StoreError(404, "no_route", "No such route.");
  };

  app.get("/_dev/mail", (c) => {
    devOnly(c);
    const rows = devOutbox
      .map(
        (m, i) =>
          `<article><h2>${esc(m.subject)}</h2><p class="small muted">To ${esc(m.to)} · ${esc(m.at)}${m.html ? ` · <a href="/_dev/mail/${i}.html">HTML part</a>` : ""}</p><pre>${esc(m.text)}</pre></article>`,
      )
      .join("");
    return html(
      `<h1>Dev outbox</h1><form method="post" action="/_dev/mail/send"><p><button type="submit">Send what waits now</button></p></form>${rows || "<p>No mail yet.</p>"}`,
      200,
      {},
      "Dev outbox",
      { wide: true },
    );
  });

  // A mail's HTML part as a mail client draws it (TEMPRA-287): its own inline styles, no script.
  app.get("/_dev/mail/:n{[0-9]+\\.html}", (c) => {
    devOnly(c);
    const m = devOutbox[Number.parseInt(c.req.param("n"), 10)];
    if (!m?.html) throw new StoreError(404, "no_route", "No such mail.");
    return new Response(m.html, {
      headers: {
        ...PAGE_HEADERS,
        "Content-Security-Policy":
          "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'",
      },
    });
  });

  app.get("/_dev/mail.json", (c) => {
    devOnly(c);
    return c.json({ mails: devOutbox });
  });

  // Runs the immediate mail now, without its quiet period, into the outbox.
  app.post("/_dev/mail/send", async (c) => {
    devOnly(c);
    const d = deps(c.env);
    const r = await flushMail(
      {
        accounts: d.accounts,
        notifications: notificationsOf(d),
        // Through MAIL_QUEUE as deployed (TEMPRA-89); its consumer puts it in the outbox.
        outbox: d.outbox ?? null,
        origin: new URL(c.req.url).origin,
        now: new Date(),
      },
      { force: true },
    );
    if ((c.req.header("Accept") ?? "").includes("application/json")) return c.json(r);
    return c.redirect("/_dev/mail", 303);
  });
}
