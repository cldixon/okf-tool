import { href as designHref } from "@tempra/design";
import type { Day } from "./analytics";
import type { ActivityCounts, Outcome, People } from "./operator";

/**
 * The portal's pages (TEMPRA-278): server-rendered from the design package's public frame and
 * base styles (design/src/public.css, base.css), no script, nothing styled inline. Little text.
 */

export const esc = (value: string) => value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "3 Nov 2026, 14:05 UTC"; a page rendered on the server cannot know the reader's zone. */
export function when(iso: string | null): string {
  if (!iso) return "–";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "–";
  const hm = `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}, ${hm} UTC`;
}

const time = (iso: string | null) =>
  iso ? `<time datetime="${esc(iso)}">${esc(when(iso))}</time>` : "–";

export function frame(title: string, body: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${esc(title)} · Tempra admin</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="${designHref}"></head>
<body class="public"><a class="skip-link" href="#main">Skip to content</a>
<header class="public-head"><a class="wordmark" href="/"><span class="wordmark-tile" aria-hidden="true">T</span>Tempra admin</a>
<nav class="public-nav" aria-label="Main"><a href="/cdn-cgi/access/logout">Sign out</a></nav></header>
<main id="main" class="public-main">${body}</main></body></html>`;
}

/** What an invite or a decision did, said on the page after it. */
const SAID: Record<Outcome, { ok: boolean; text: (email: string) => string }> = {
  invited: { ok: true, text: (e) => `${e} is invited and has been emailed.` },
  already: { ok: true, text: (e) => `${e} was already invited; no email sent.` },
  dismissed: { ok: true, text: (e) => `${e} dismissed.` },
  missing: { ok: false, text: (e) => `${e} was not waiting.` },
  bad_email: { ok: false, text: (e) => `"${e}" does not look like an email address.` },
  mail_failed: {
    ok: false,
    text: (e) => `${e} is invited, but the email failed. Tell them yourself.`,
  },
  no_mail: {
    ok: false,
    text: (e) => `${e} is invited. This deployment sends no email; tell them yourself.`,
  },
};

export function isOutcome(v: string | undefined): v is Outcome {
  return v !== undefined && Object.hasOwn(SAID, v);
}

function notice(done: { outcome: Outcome; email: string } | null): string {
  if (!done) return "";
  const s = SAID[done.outcome];
  return `<p class="notice${s.ok ? " ok" : ""}" role="status">${esc(s.text(done.email))}</p>`;
}

function table(caption: string, head: string[], rows: string[][], empty: string): string {
  if (!rows.length) return `<p class="muted">${esc(empty)}</p>`;
  return `<table><caption class="visually-hidden">${esc(caption)}</caption><thead><tr>${head
    .map((h) => `<th scope="col">${esc(h)}</th>`)
    .join("")}</tr></thead><tbody>
${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`).join("\n")}
</tbody></table>`;
}

const decideForm = (email: string) => `<form method="post" action="/decide">
<input type="hidden" name="email" value="${esc(email)}">
<button type="submit" name="decision" value="invited" aria-label="Approve ${esc(email)}">Approve</button>
<button type="submit" name="decision" value="dismissed" aria-label="Dismiss ${esc(email)}">Dismiss</button></form>`;

/** Daily accounts with agents at work, as bars: an SVG with no style, its ink the text's. */
export function chart(days: Day[]): string {
  const max = Math.max(1, ...days.map((d) => d.accounts));
  const w = 10;
  const h = 80;
  const bars = days
    .map((d, i) => {
      const bh = Math.round((d.accounts / max) * h);
      return `<rect x="${i * w + 1}" y="${h - bh}" width="${w - 2}" height="${bh}" fill="currentColor"><title>${esc(d.day)}: ${d.accounts}</title></rect>`;
    })
    .join("");
  const label = `Accounts with agents at work each day, the last ${days.length} days; at most ${max}.`;
  return `<svg viewBox="0 0 ${days.length * w} ${h}" width="100%" height="${h}" preserveAspectRatio="none" role="img" aria-label="${esc(label)}">${bars}</svg>`;
}

function activity(a: ActivityCounts | null, days: Day[] | null): string {
  if (!a) return `<p class="notice" role="status">The app did not answer.</p>`;
  const row = (name: string, w: { day: number; week: number; month: number }) => [
    esc(name),
    String(w.day),
    String(w.week),
    String(w.month),
  ];
  const windows = table(
    "Active in the last day, 7 days and 30 days",
    ["Active", "1 day", "7 days", "30 days"],
    [row("People", a.people), row("Agents", a.agents)],
    "",
  );
  const history = days
    ? `<h3>Agents at work, last 30 days</h3>${chart(days)}
<details><summary>By day</summary>${table(
        "By day",
        ["Day", "Accounts", "Requests", "Writes"],
        [...days]
          .reverse()
          .map((d) => [esc(d.day), String(d.accounts), String(d.requests), String(d.writes)]),
        "",
      )}</details>`
    : `<p class="muted">The daily history needs an Analytics read token (ANALYTICS_TOKEN).</p>`;
  return `<p>${a.accounts} accounts, ${a.libraries} libraries.</p>${windows}${history}`;
}

export function home(view: {
  people: People | null;
  activity: ActivityCounts | null;
  days: Day[] | null;
  done: { outcome: Outcome; email: string } | null;
}): string {
  const p = view.people;
  const lists = p
    ? `<section aria-labelledby="waiting"><h2 id="waiting">Waiting (${p.waiting.length})</h2>
${table(
  "Waiting",
  ["Email", "Asked", "Decision"],
  p.waiting.map((w) => [esc(w.email), time(w.asked), decideForm(w.email)]),
  "Nobody is waiting.",
)}</section>
<section aria-labelledby="signed-up"><h2 id="signed-up">Signed up (${p.signedUp.length})</h2>
${table(
  "Signed up",
  ["Email", "Handle", "Invited", "Signed up"],
  p.signedUp.map((s) => [
    esc(s.email),
    s.handle ? `@${esc(s.handle)}` : "–",
    time(s.invited),
    time(s.created),
  ]),
  "Nobody invited has signed up yet.",
)}</section>
<section aria-labelledby="not-yet"><h2 id="not-yet">Not signed up yet (${p.notYet.length})</h2>
${table(
  "Not signed up yet",
  ["Email", "Invited"],
  p.notYet.map((n) => [esc(n.email), time(n.invited)]),
  "Everyone invited has signed up.",
)}</section>`
    : `<p class="notice" role="status">The app did not answer.</p>`;
  return frame(
    "People",
    `<h1>People</h1>${notice(view.done)}
<section aria-labelledby="invite"><h2 id="invite">Invite</h2>
<form method="post" action="/invite"><div class="field"><label for="email">Email</label>
<input id="email" name="email" type="email" required autocomplete="off"></div>
<button type="submit" class="primary">Invite</button></form>
<p class="muted">They get an email saying they can sign in.</p></section>
${lists}
<section aria-labelledby="activity"><h2 id="activity">Activity</h2>${activity(view.activity, view.days)}</section>`,
  );
}

export function message(title: string, text: string): string {
  return frame(title, `<h1>${esc(title)}</h1><p>${esc(text)}</p>`);
}
