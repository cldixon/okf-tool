import type { Accounts } from "./accounts";
import { mailKey, type Outbox } from "./mail-queue";
import { renderMail } from "./mail-template";
import type { Item, Notifications } from "./notify";
import type { Mailer } from "./signin";

/**
 * Notification mail (TEMPRA-74, TEMPRA-189): the mentions and replies addressed to a person,
 * batched so a burst is one mail, behind one switch. Every mail carries a one-click unsubscribe
 * (RFC 8058) and counts against the person's daily cap. Free of Worker APIs: the cron and tests
 * drive it.
 */

/** A batch waits this long after its newest item, so a burst of replies is one mail... */
export const QUIET_MS = 2 * 60_000;
/** ...but no longer than this after its oldest. */
export const MAX_WAIT_MS = 10 * 60_000;

export interface MailDeps {
  accounts: Accounts;
  notifications: Notifications;
  /** Where the batches go: MAIL_QUEUE (TEMPRA-89), whose consumer sends and meters them. */
  outbox: Outbox | null;
  /** The app's origin for links: https://tempra.dev. */
  origin: string;
  now: Date;
}

const day = (d: Date) => d.toISOString().slice(0, 10);

const KIND_TEXT: Record<string, string> = {
  reply: "replied",
  mention: "mentioned you",
  invitation: "invited you",
};

/** Who did it, as people read it: @ann for a person, the actor otherwise. */
const who = (actor: string) => actor.replace(/^human:/, "@");

/** Where an item leads in the app. */
export function itemLink(
  origin: string,
  i: Pick<Item, "kind" | "place" | "path"> & { thread?: string | null },
): string {
  if (i.kind === "invitation") return `${origin}/invitations`;
  // The account's monthly quotas (TEMPRA-232): the Account page's usage.
  if (i.kind === "quota") return `${origin}/account#usage`;
  // A library thread (TEMPRA-222) opens on the library's home.
  if (!i.path && i.thread) return `${origin}/${i.place}/#thread-${encodeURIComponent(i.thread)}`;
  if (!i.path) return `${origin}/${i.place}/`;
  const path = i.path.split("/").map(encodeURIComponent).join("/");
  return `${origin}/${i.place}/${path}#comments`;
}

function itemLine(i: Item): string {
  const where = i.path ? ` on ${i.path}` : i.thread ? " on the library" : "";
  return `${who(i.actor)} ${KIND_TEXT[i.kind] ?? i.kind}${where} in ${i.place}`;
}

export interface Composed {
  subject: string;
  text: string;
  html: string;
  headers: Record<string, string>;
}

/** The unsubscribe link and headers every notification mail carries. */
function footer(origin: string, key: string) {
  const unsubscribe = `${origin}/unsubscribe?k=${key}`;
  const settings = `${origin}/account#email`;
  return {
    links: [
      { label: "Email settings", href: settings },
      { label: "Unsubscribe", href: unsubscribe },
    ],
    // Mail providers reject non-https unsubscribe URIs; local dev has none to send anyway.
    headers: origin.startsWith("https:")
      ? {
          "List-Unsubscribe": `<${unsubscribe}>`,
          "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
        }
      : ({} as Record<string, string>),
  };
}

/**
 * One mail for a person's batch of items, in the mail template (TEMPRA-287): each item a link to
 * its thread with its excerpt, Open Tempra as the button, the settings and unsubscribe links in
 * the foot.
 */
export function composeBatch(origin: string, key: string, items: Item[]): Composed {
  const first = items[0];
  const one = items.length === 1 && first;
  const subject = one
    ? `${who(first.actor)} ${KIND_TEXT[first.kind] ?? first.kind}${first.path ? ` on ${first.path}` : ""}`
    : `${items.length} new notifications in Tempra`;
  const f = footer(origin, key);
  const mail = renderMail({
    headline: one ? subject : `${items.length} new notifications`,
    line: one ? `In ${first.place}.` : "Mentions and replies since your last email.",
    items: items.map((i) => ({
      title: itemLine(i),
      href: itemLink(origin, i),
      excerpt: i.excerpt ?? undefined,
    })),
    button: { label: "Open Tempra", href: `${origin}/` },
    foot: "You get these for mentions and replies.",
    footLinks: f.links,
  });
  return { subject, text: mail.text, html: mail.html, headers: f.headers };
}

/**
 * Queues one notification mail within the person's cap (TEMPRA-89): the MAIL_QUEUE consumer sends
 * it with retries, once per batch (its key is the batch's items). The cap's slot is taken here,
 * so retries never spend it twice. "unsent" when it could not be queued: the items stay pending
 * for the next run.
 */
async function deliver(
  d: MailDeps,
  user: { id: string; email: string; handle: string },
  items: Item[],
  compose: (key: string) => Composed,
): Promise<"queued" | "capped" | "none" | "unsent"> {
  if (!d.outbox) return "none";
  if (!(await d.notifications.takeMailSlot(user.id, day(d.now)))) return "capped";
  const m = compose(await d.notifications.unsubscribeKey(user.id));
  try {
    await d.outbox.send({
      key: mailKey(`notify:${user.id}`, ...items.map((i) => i.id).sort()),
      kind: "notification",
      account: user.handle,
      to: user.email,
      ...m,
    });
    return "queued";
  } catch (e) {
    console.error(JSON.stringify({ mail_not_queued: "notification", error: String(e) }));
    return "unsent";
  }
}

/**
 * The immediate mail (the 5-minute cron): one mail per person for what waits, once their batch
 * is quiet (or has waited long enough). Items already done in the app (opened), with the
 * person's mail off, or from libraries the person no longer reaches are skipped, never mailed
 * later. `force`
 * sends what waits now (the dev outbox's Send now).
 */
export async function flushMail(d: MailDeps, opts: { force?: boolean } = {}) {
  const now = d.now.getTime();
  const out = { mails: 0, items: 0, skipped: 0, waiting: 0 };
  for (const { user: id, items } of await d.notifications.pendingMail()) {
    const newest = Math.max(...items.map((i) => Date.parse(i.created)));
    const oldest = Math.min(...items.map((i) => Date.parse(i.created)));
    if (!opts.force && now - newest < QUIET_MS && now - oldest < MAX_WAIT_MS) {
      out.waiting += items.length;
      continue;
    }
    const user = await d.accounts.account(id);
    const prefs = await d.notifications.prefs(id);
    const reach = user ? new Set((await d.accounts.reachable(id)).map((l) => l.id)) : new Set();
    const send = items.filter(
      (i) =>
        user && prefs.email && i.done_at === null && (i.library === null || reach.has(i.library)),
    );
    const skip = items.filter((i) => !send.includes(i)).map((i) => i.id);
    let sent: string[] = [];
    if (user && send.length > 0) {
      const r = await deliver(d, user, send, (key) => composeBatch(d.origin, key, send));
      if (r === "queued") {
        sent = send.map((i) => i.id);
        out.mails++;
        out.items += sent.length;
      } else if (r === "unsent") {
        // Not queued: left pending, so the next run tries again (within the daily cap).
        out.waiting += send.length;
      } else skip.push(...send.map((i) => i.id));
    }
    await d.notifications.setMail(sent, "sent");
    await d.notifications.setMail(skip, "skipped");
    out.skipped += skip.length;
  }
  return out;
}

// ---------------------------------------------------------------- local dev

/**
 * Local dev (DEV_SIGNIN=1): queued mail (notifications, invitations, quota notices) is kept here
 * by the MAIL_QUEUE consumer and shown at /_dev/mail instead of being sent, as sign-in links are
 * shown on the page. One isolate in `cf dev`; newest first.
 */
export const devOutbox: (Parameters<Mailer["send"]>[0] & { at: string })[] = [];

export const devMailer: Mailer = {
  async send(m) {
    devOutbox.unshift({ ...m, at: new Date().toISOString() });
    devOutbox.length = Math.min(devOutbox.length, 100);
    console.log(`Mail for ${m.to}: ${m.subject}`);
  },
};

/**
 * A library's invitation mail (TEMPRA-62), in the mail template (TEMPRA-287): who invited, to
 * which library and with what access, one button to accept or decline.
 */
export function libraryInvitationMail(
  who: string,
  library: string,
  role: string,
  origin: string,
): { text: string; html: string } {
  return renderMail({
    headline: `${who} invited you to ${library}`,
    line: `You can ${role === "write" ? "read, comment and write" : "read and comment"} there once you accept.`,
    button: { label: "Accept or decline", href: `${origin}/invitations` },
    foot: "The invitation is open for 14 days. Didn't expect it? Ignore this email.",
  });
}
