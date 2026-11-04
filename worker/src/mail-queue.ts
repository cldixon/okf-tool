import { sha256Hex } from "./format/hash";
import type { Mailer } from "./signin";

/**
 * Outgoing mail through a Queue (TEMPRA-89; tempra-dev: decisions/mail-through-a-queue): mail
 * nobody is waiting on (invitations, notification batches, quota notices, the waitlist's, the
 * operator's digest) is queued on MAIL_QUEUE, one message per mail, and the consumer sends it
 * with backoff. Each mail carries a dedupe key, claimed in D1 `mail_sent` before sending, so a
 * redelivery never mails twice. Sign-in links stay synchronous (signin.ts `sendLink`). Free of
 * Worker APIs: index.ts wires the Queue and the binding, tests drive the consumer.
 */

export type MailKind =
  | "invitation"
  | "notification"
  | "quota"
  | "waitlist"
  | "account"
  | "operator";

/** One mail to send: what producers hand the outbox. */
export interface OutgoingMail {
  /** Dedupe key: the same key is sent at most once (for 14 days). */
  key: string;
  kind: MailKind;
  to: string;
  subject: string;
  text: string;
  html?: string;
  headers?: Record<string, string>;
  /** Whose mail it is, for metering (`email` usage); none for the operator's. */
  account?: string;
}

/** The Queue message: the mail and when it was queued. */
export interface MailJob extends OutgoingMail {
  v: 1;
  queued: string;
}

/** Where producers put mail: the Queue in a deployment, the test outbox in tests. */
export interface Outbox {
  send(m: OutgoingMail): Promise<void>;
}

/** The outbox over a Queue's send (index.ts passes MAIL_QUEUE's). */
export function queueOutbox(send: (job: MailJob) => Promise<void>, now = () => new Date()): Outbox {
  return {
    async send(m) {
      await send({ v: 1, queued: now().toISOString(), ...m });
    },
  };
}

/** A dedupe key from parts that may be long or hold an address: a short hash of them. */
export const mailKey = (prefix: string, ...parts: string[]) =>
  `${prefix}:${sha256Hex(parts.join("\n")).slice(0, 32)}`;

export function isMailJob(x: unknown): x is MailJob {
  const m = x as Partial<MailJob> | null;
  return (
    !!m &&
    m.v === 1 &&
    typeof m.key === "string" &&
    !!m.key &&
    typeof m.to === "string" &&
    typeof m.subject === "string" &&
    typeof m.text === "string"
  );
}

// ------------------------------------------------------------------ dedupe

/** A claim older than this is taken over: its sender died between claiming and marking. */
export const CLAIM_STALE_MS = 5 * 60_000;
/** How long sent keys are kept (sweep.ts pruneAccounts). */
export const MAIL_SENT_RETENTION_DAYS = 14;

/** The consumer's record of keys: claimed while sending, sent after. */
export interface SentLog {
  /** "claimed": ours to send; "sent": already sent; "busy": another delivery is sending it. */
  claim(key: string, now: Date): Promise<"claimed" | "sent" | "busy">;
  sent(key: string, now: Date): Promise<void>;
  /** Gives a claim back after a failed send, so a retry can take it. */
  release(key: string): Promise<void>;
}

export function d1SentLog(db: D1Database): SentLog {
  return {
    async claim(key, now) {
      const at = now.toISOString();
      const stale = new Date(now.getTime() - CLAIM_STALE_MS).toISOString();
      const r = await db
        .prepare(
          `INSERT INTO mail_sent (key, claimed_at) VALUES (?1, ?2)
           ON CONFLICT (key) DO UPDATE SET claimed_at = ?2
           WHERE mail_sent.sent_at IS NULL AND mail_sent.claimed_at < ?3`,
        )
        .bind(key, at, stale)
        .run();
      if ((r.meta.changes ?? 0) > 0) return "claimed";
      const row = await db
        .prepare("SELECT sent_at FROM mail_sent WHERE key = ?")
        .bind(key)
        .first<{ sent_at: string | null }>();
      return row?.sent_at ? "sent" : "busy";
    },
    async sent(key, now) {
      await db
        .prepare("UPDATE mail_sent SET sent_at = ? WHERE key = ?")
        .bind(now.toISOString(), key)
        .run();
    },
    async release(key) {
      await db.prepare("DELETE FROM mail_sent WHERE key = ? AND sent_at IS NULL").bind(key).run();
    },
  };
}

// ------------------------------------------------------------------ the consumer

/** Attempts in all (the consumer's maxRetries in cloudflare.config.ts is one less). */
export const MAIL_ATTEMPTS = 5;

/** The wait before the next attempt after `attempts` failed: 30 s, 2, 8, then 15 minutes. */
export function backoffSeconds(attempts: number): number {
  return Math.min(30 * 4 ** Math.max(0, attempts - 1), 900);
}

/**
 * Email Service's errors that another try will not mend (its Workers API error codes): the
 * recipient, the sender, the content or the account is wrong, or the day's quota is spent.
 * Anything else, a code or none, is tried again.
 */
const PERMANENT = new Set([
  "E_RECIPIENT_SUPPRESSED",
  "E_RECIPIENT_NOT_ALLOWED",
  "E_SENDER_NOT_VERIFIED",
  "E_SENDER_NOT_ALLOWED",
  "E_SENDER_DOMAIN_NOT_AVAILABLE",
  "E_CONTENT_TOO_LARGE",
  "E_HEADER_NOT_ALLOWED",
  "E_HEADER_USE_API_FIELD",
  "E_HEADER_VALUE_INVALID",
  "E_HEADER_VALUE_TOO_LONG",
  "E_HEADER_NAME_INVALID",
  "E_HEADERS_TOO_LARGE",
  "E_HEADERS_TOO_MANY",
  "E_VALIDATION_ERROR",
  "E_FIELD_MISSING",
  "E_TOO_MANY_RECIPIENTS",
  "E_ACCOUNT_SUSPENDED",
  "E_DAILY_LIMIT_EXCEEDED",
]);

export function permanentFailure(e: unknown): boolean {
  const code = (e as { code?: unknown } | null)?.code;
  return typeof code === "string" && PERMANENT.has(code);
}

export interface MailConsumerDeps {
  /** The Email Service binding (the dev outbox locally); null: nothing can be sent. */
  mailer: Mailer | null;
  sent: SentLog;
  /** Counts a mail that will not be sent, for the operator digest (notify.ts mail_failures). */
  recordFailure(day: string): Promise<void>;
  meter?: (e: { kind: "email"; account: string }) => void;
  now: () => Date;
}

export type MailOutcome =
  | { ack: "sent" | "duplicate" | "dropped" | "failed" }
  | { retry: number; why: "busy" | "failed" };

/**
 * One queued mail: claim its key, send, mark it sent. `attempts` is the message's (1 the first
 * time). Answers whether to ack it or retry it after so many seconds.
 */
export async function handleMailMessage(
  d: MailConsumerDeps,
  body: unknown,
  attempts: number,
): Promise<MailOutcome> {
  if (!isMailJob(body)) {
    console.error(JSON.stringify({ mail_message_unknown: true }));
    return { ack: "dropped" };
  }
  const { key, kind } = body;
  if (!d.mailer) {
    // No sending domain for this deployment (cloudflare.config.ts mailFrom): nothing to retry.
    console.error(JSON.stringify({ mail_dropped: kind, key, reason: "no mailer" }));
    return { ack: "dropped" };
  }
  const claim = await d.sent.claim(key, d.now());
  if (claim === "sent") return { ack: "duplicate" };
  if (claim === "busy") {
    if (attempts >= MAIL_ATTEMPTS) return { ack: "dropped" };
    return { retry: backoffSeconds(attempts), why: "busy" };
  }
  try {
    await d.mailer.send({
      to: body.to,
      subject: body.subject,
      text: body.text,
      ...(body.html ? { html: body.html } : {}),
      ...(body.headers ? { headers: body.headers } : {}),
    });
  } catch (e) {
    await d.sent.release(key).catch(() => {});
    const permanent = permanentFailure(e);
    const code = (e as { code?: unknown } | null)?.code;
    // The address is never logged (v2 spec: Observability); the key names the mail.
    console.error(
      JSON.stringify({ mail_failed: kind, key, attempt: attempts, code, error: String(e) }),
    );
    if (!permanent && attempts < MAIL_ATTEMPTS) {
      return { retry: backoffSeconds(attempts), why: "failed" };
    }
    await d.recordFailure(d.now().toISOString().slice(0, 10)).catch(() => {});
    return { ack: "failed" };
  }
  await d.sent.sent(key, d.now());
  if (body.account) d.meter?.({ kind: "email", account: body.account });
  return { ack: "sent" };
}

/**
 * Sends a mail now, trying once more after a short pause if the first send fails: for links a
 * person is waiting on (sign-in, a new email's confirmation), which stay out of the Queue.
 */
export async function sendNow(
  mailer: Mailer,
  m: Parameters<Mailer["send"]>[0],
  pauseMs = 500,
): Promise<void> {
  try {
    await mailer.send(m);
  } catch (e) {
    if (permanentFailure(e)) throw e;
    await new Promise((r) => setTimeout(r, pauseMs));
    await mailer.send(m);
  }
}
