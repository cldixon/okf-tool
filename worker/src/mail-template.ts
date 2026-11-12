import { brand } from "@tempra/design/brand";
import { MARK_PATHS, MARK_VIEWBOX } from "@tempra/design/mark";
import type { Mailer } from "./signin";

/**
 * The one mail template (TEMPRA-287, tempra-dev `v2/accounts.md`, The email): the Tempra mark and
 * name, a short orange rule (Tempra's one accent, as on the server pages), a headline, one line,
 * optionally a list of items (a notification batch's), at most one button, an optional code, and
 * a muted foot over a hairline, with links after it if the mail has any; an HTML part and a text part with the same words. Light, and dark under
 * `prefers-color-scheme: dark` where the client honours it, in the design package's colours
 * (`@tempra/design/brand`). Mail clients take no stylesheet but a `<style>` in the head, and
 * Gmail not even that, so the light look is inline and dark is the `<style>`'s overrides. Free of
 * Worker APIs.
 */

export interface MailContent {
  /** The headline, as plain text. */
  headline: string;
  /** One line under it, as plain text. */
  line: string;
  /** The one action: a link drawn as a pill. */
  button?: { label: string; href: string };
  /** A code to type, shown large in a monospace face under a small label. */
  code?: { label: string; value: string };
  /**
   * Items under the line (a batch of notifications): each a title linking to it, with a muted
   * excerpt under it.
   */
  items?: { title: string; href: string; excerpt?: string }[];
  /** The small print, as plain text. */
  foot: string;
  /** Links after the small print (Email settings, Unsubscribe). */
  footLinks?: { label: string; href: string }[];
}

/** Who every mail is from, beside MAIL_FROM's address: "Tempra <noreply@…>". */
export const MAIL_FROM_NAME = "Tempra";

/** Cloudflare Email Service's binding, as far as the Worker sends through it. */
export type MailBinding = {
  send(m: {
    from: { name: string; email: string };
    to: string;
    subject: string;
    text: string;
    html?: string;
    headers?: Record<string, string>;
  }): Promise<unknown>;
};

/** The mailer over the binding, from MAIL_FROM_NAME at `address`. */
export function bindingMailer(binding: MailBinding, address: string): Mailer {
  return {
    async send(m) {
      await binding.send({ from: { name: MAIL_FROM_NAME, email: address }, ...m });
    },
  };
}

const esc = (value: string) => value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const { light, dark } = brand;

const SANS = "Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif";
const MONO = "ui-monospace,SFMono-Regular,Menlo,Consolas,monospace";

/** Dark, where the client honours it: every inline colour has a class to override it. */
const DARK_CSS = `:root{color-scheme:light dark;supported-color-schemes:light dark}
@media (prefers-color-scheme:dark){
.t-bg{background:${dark.bg}!important}
.t-text{color:${dark.text}!important}
.t-muted{color:${dark.muted}!important}
.t-rule{border-color:${dark.border}!important}
.t-accent{background:${dark.agent}!important}
.t-code{background:${dark.ground}!important;color:${dark.text}!important}
.t-button{background:${dark.text}!important;color:${dark.bg}!important}
.t-front{fill:${dark.markFront}!important}
.t-mid{fill:${dark.markMid}!important}
.t-back{fill:${dark.markBack}!important}
}`;

/** The mark (the small cut, at 16px) beside the name, as the server pages' lockup draws it. */
function lockup(): string {
  const p = MARK_PATHS.small;
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 32px"><tr>
<td style="padding:0 8px 0 0;vertical-align:middle"><svg width="14" height="16" viewBox="${MARK_VIEWBOX}" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" style="display:block"><path class="t-back" fill="${light.markBack}" d="${p.back}"/><path class="t-mid" fill="${light.markMid}" d="${p.middle}"/><path class="t-front" fill="${light.markFront}" d="${p.front}"/></svg></td>
<td class="t-text" style="vertical-align:middle;color:${light.text};font-family:${SANS};font-size:17px;font-weight:600;letter-spacing:-0.01em;line-height:20px">Tempra</td>
</tr></table>`;
}

/** The mail's HTML and text parts. */
export function renderMail(m: MailContent): { html: string; text: string } {
  const button = m.button
    ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 28px"><tr><td class="t-button" style="border-radius:999px;background:${light.text}"><a class="t-button" href="${esc(m.button.href)}" style="display:inline-block;padding:10px 20px;border-radius:999px;background:${light.text};color:${light.bg};font-family:${SANS};font-size:15px;font-weight:500;line-height:20px;text-decoration:none">${esc(m.button.label)}</a></td></tr></table>`
    : "";
  const code = m.code
    ? `<p class="t-muted" style="margin:0 0 8px;color:${light.muted};font-family:${SANS};font-size:13px;line-height:20px">${esc(m.code.label)}</p>
<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 32px"><tr><td class="t-code" style="padding:12px 20px;border-radius:8px;background:${light.ground};color:${light.text};font-family:${MONO};font-size:28px;font-weight:600;letter-spacing:0.16em;line-height:36px">${esc(m.code.value)}</td></tr></table>`
    : "";
  const items = m.items?.length
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 28px">${m.items
        .map(
          (i) =>
            `<tr><td class="t-rule" style="padding:12px 0;border-top:1px solid ${light.border}"><a class="t-text" href="${esc(i.href)}" style="color:${light.text};font-family:${SANS};font-size:15px;font-weight:500;line-height:22px;text-decoration:underline;text-decoration-thickness:1px;text-underline-offset:3px">${esc(i.title)}</a>${
              i.excerpt
                ? `<p class="t-muted" style="margin:4px 0 0;color:${light.muted};font-family:${SANS};font-size:14px;line-height:21px">${esc(i.excerpt)}</p>`
                : ""
            }</td></tr>`,
        )
        .join("")}</table>`
    : "";
  const footLinks = m.footLinks?.length
    ? `<br>${m.footLinks
        .map(
          (l) =>
            `<a class="t-muted" href="${esc(l.href)}" style="color:${light.muted};text-decoration:underline">${esc(l.label)}</a>`,
        )
        .join(" &#183; ")}`
    : "";
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark"><meta name="supported-color-schemes" content="light dark">
<title>${esc(m.headline)}</title><style>${DARK_CSS}</style></head>
<body class="t-bg" style="margin:0;padding:0;background:${light.bg}">
<table role="presentation" class="t-bg" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${light.bg}"><tr><td style="padding:40px 24px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:480px"><tr><td>
${lockup()}
<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 16px"><tr><td class="t-accent" width="24" height="2" style="width:24px;height:2px;font-size:0;line-height:0;background:${light.agent}">&#8203;</td></tr></table>
<h1 class="t-text" style="margin:0 0 10px;color:${light.text};font-family:${SANS};font-size:22px;font-weight:500;letter-spacing:-0.01em;line-height:28px">${esc(m.headline)}</h1>
<p class="t-muted" style="margin:0 0 24px;color:${light.muted};font-family:${SANS};font-size:15px;line-height:23px">${esc(m.line)}</p>
${items}${button}${code}<p class="t-muted t-rule" style="margin:0;padding:16px 0 0;border-top:1px solid ${light.border};color:${light.muted};font-family:${SANS};font-size:13px;line-height:20px">${esc(m.foot)}${footLinks}</p>
</td></tr></table>
</td></tr></table>
</body></html>`;
  const text = [
    m.headline,
    m.line,
    ...(m.items ?? []).map((i) => `${i.title}${i.excerpt ? `\n  ${i.excerpt}` : ""}\n  ${i.href}`),
    m.button ? `${m.button.label}:\n${m.button.href}` : "",
    m.code ? `${m.code.label}: ${m.code.value}` : "",
    [m.foot, ...(m.footLinks ?? []).map((l) => `${l.label}: ${l.href}`)].join("\n"),
  ]
    .filter(Boolean)
    .join("\n\n");
  return { html, text: `${text}\n` };
}
