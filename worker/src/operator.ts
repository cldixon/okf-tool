import type { ActivityCounts } from "./accounts";
import type { Deps } from "./app";
import { mailKey } from "./mail-queue";
import { renderMail } from "./mail-template";
import { INVITATION_DAYS } from "./session";
import { EMAIL } from "./signin";

/**
 * What the operator does from the portal (TEMPRA-278, tempra-dev `decisions/an-admin-portal.md`):
 * who has access, inviting, the waitlist's decisions and the activity numbers. The admin Worker
 * (admin/) calls these through the `Operator` RPC entrypoint (index.ts), which has no route; the
 * app's own /waitlist page shares the invitation mail. Free of Worker APIs.
 */

/** Who has access, as the portal lists them. */
export interface People {
  /** Asked to join, not decided yet; oldest first. */
  waiting: { email: string; asked: string }[];
  /** Invited and signed up; newest invitation first. */
  signedUp: { email: string; handle: string | null; invited: string; created: string | null }[];
  /** Invited, no account yet; newest invitation first. */
  notYet: { email: string; invited: string }[];
}

/** What the invitation mail came to: queued, failed to queue, or no mail on this deployment. */
export type MailOutcome = "sent" | "mail_failed" | "no_mail";

/** What an invite or a decision did, for the page after it. */
export type Outcome =
  | "invited"
  | "already"
  | "dismissed"
  | "missing"
  | "bad_email"
  | "mail_failed"
  | "no_mail";

/**
 * The invitation, "You're in" (TEMPRA-287): one button that signs the person in, a sign-in link
 * of its own kind (single use, INVITATION_DAYS long, no code; `Sessions.createInvitationLink`),
 * in the one mail template. Queued (TEMPRA-89), once a day per email (its dedupe key), so a
 * repeated click never mails twice; a link made for a mail that dedupe drops is never sent, and
 * lapses unused.
 */
export async function sendInvitation(
  d: Pick<Deps, "outbox" | "sessions">,
  email: string,
  origin: string,
  opts: { asked?: boolean; now?: Date } = {},
): Promise<MailOutcome> {
  if (!d.outbox) return "no_mail";
  try {
    const secret = await d.sessions.createInvitationLink(email);
    await d.outbox.send({
      key: mailKey("waitlist-in", email, (opts.now ?? new Date()).toISOString().slice(0, 10)),
      kind: "waitlist",
      account: email,
      to: email,
      subject: "You're in: Tempra",
      ...invitationMail(`${origin}/sign-in/link?t=${secret}`, origin, opts.asked ?? false),
    });
    return "sent";
  } catch (e) {
    console.error(JSON.stringify({ mail_not_queued: "invitation", error: String(e) }));
    return "mail_failed";
  }
}

/** The invitation's words: one button that signs in, and what to do once it has lapsed. */
export function invitationMail(link: string, origin: string, asked: boolean) {
  return renderMail({
    headline: "You're in",
    line: asked
      ? "You asked to join Tempra, and you're in. The button signs you in."
      : "You're invited to Tempra. The button signs you in.",
    button: { label: "Sign in to Tempra", href: link },
    foot: `Works once, within ${INVITATION_DAYS} days. After that, sign in with this email at ${new URL(origin).host}.`,
  });
}

const DAY = 86_400_000;

export function operatorOps(d: Pick<Deps, "accounts" | "outbox" | "sessions">, origin: string) {
  return {
    async people(): Promise<People> {
      const [waiting, invited] = await Promise.all([d.accounts.waitlist(), d.accounts.invited()]);
      return {
        waiting: waiting.map((w) => ({ email: w.email, asked: w.created })),
        signedUp: invited.flatMap((i) =>
          i.account
            ? [
                {
                  email: i.email,
                  handle: i.account.handle,
                  invited: i.invited,
                  created: i.account.created,
                },
              ]
            : [],
        ),
        notYet: invited.flatMap((i) => (i.account ? [] : [{ email: i.email, invited: i.invited }])),
      };
    },

    /** Invites an email and mails them; an email invited before is not mailed again. */
    async invite(raw: string): Promise<Outcome> {
      const email = raw.trim().toLowerCase();
      if (!EMAIL.test(email) || email.length > 254) return "bad_email";
      const { added } = await d.accounts.inviteEmail(email);
      if (!added) return "already";
      const mailed = await sendInvitation(d, email, origin);
      return mailed === "sent" ? "invited" : mailed;
    },

    /** Approves (invites and mails) or dismisses a waiting email. */
    async decide(raw: string, decision: "invited" | "dismissed"): Promise<Outcome> {
      const email = raw.trim().toLowerCase();
      if (!(await d.accounts.decideWaitlist(email, decision))) return "missing";
      if (decision === "dismissed") return "dismissed";
      const mailed = await sendInvitation(d, email, origin, { asked: true });
      return mailed === "sent" ? "invited" : mailed;
    },

    async activity(now = Date.now()): Promise<ActivityCounts> {
      const ago = (days: number) => new Date(now - days * DAY).toISOString();
      return d.accounts.activityCounts({ day: ago(1), week: ago(7), month: ago(30) });
    },
  };
}
