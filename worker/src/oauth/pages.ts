import type { ConsentDescription } from "@cloudflare/workers-oauth-provider";
import { href as designHref } from "@tempra/design";
import { markSvg } from "@tempra/design/mark";
import type { ReachableLibrary } from "../accounts";
import { LEGAL } from "../legal";

/** Escapes text for HTML; every client-supplied string passes through here. */
export const esc = (value: string) => value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/**
 * The server pages' shell (sign-in, consent, errors, the email-change link): the public pages'
 * flat frame (TEMPRA-110, TEMPRA-126), as the landing page has it: a skip link, the wordmark
 * linking to tempra.dev over a hairline, the page as a narrow column, and terms and privacy at
 * the foot. From the design stylesheet alone, with no script; sent with PAGE_HEADERS (V-11).
 */
/** The Tempra mark before the name (TEMPRA-279): the small cut, at the name's size. */
const WORDMARK = markSvg({ small: true });

export function page(title: string, body: string): string {
  // Dark, whatever the system (TEMPRA-285): there is no account here to choose otherwise.
  return `<!doctype html>
<html lang="en" data-theme="dark"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${esc(title)} · Tempra</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="${designHref}"></head>
<body class="public narrow"><a class="skip-link" href="#main">Skip to content</a>
<header class="public-head"><a class="wordmark mark-lockup" href="${LEGAL}/">${WORDMARK}Tempra</a></header>
<main id="main" class="public-main">${body}</main>
<footer class="public-foot"><nav aria-label="Footer"><ul role="list"><li><a href="${LEGAL}/terms">Terms</a></li><li><a href="${LEGAL}/privacy">Privacy</a></li></ul></nav></footer></body></html>`;
}

/**
 * A form's error (V-10): announced when the page loads, and named by the field it is about
 * through `invalid(id)`.
 */
export const alertNotice = (id: string, message: string) =>
  `<p class="notice" id="${id}" role="alert">${esc(message)}</p>`;

/** A field's attributes when the error with that id is about it. */
export const invalid = (id: string, when = true) =>
  when ? ` aria-invalid="true" aria-describedby="${id}"` : "";

/** Which consent field an error is about, to mark it (V-10). */
export type ConsentField = "libraries" | "new_library" | "create" | "prefix" | "actor";

export interface ConsentForm {
  /** All of the account's libraries, including later ones, or the selected ones only. */
  libraries: "all" | "selected";
  /** The selected libraries, by consentKey. */
  selected: string[];
  newLibrary: string;
  access: "read" | "write";
  prefix: string;
  actor: string;
  tiers: "all" | "files";
  /**
   * "Create libraries" (TEMPRA-100): the app may create libraries that the person owns. Only
   * with read and write and all tools; consent refuses it otherwise (V-9).
   */
  create: boolean;
}

/** Whether consent offers "Create libraries": not when the app asked for read access only. */
export function offersCreate(details: Pick<ConsentDescription, "scope">): boolean {
  return details.scope.length === 0 || details.scope.includes("tempra:write");
}

/**
 * How the consent form names a library: an own library by its slug, one shared with the person
 * as owner/slug (the person may own a library of the same name).
 */
export function consentKey(l: ReachableLibrary): string {
  return l.role === "owner" ? l.slug : `${l.owner}/${l.slug}`;
}

/** A library as people read it (the app's libraryLabel): its title, else its slug. */
function libraryName(l: ReachableLibrary): string {
  const name = l.title?.trim() || l.slug;
  return l.role === "owner" ? name : `${name} (@${l.owner})`;
}

const ERROR_ID = "consent-error";

/** The consent page (spec: Apps under Auth): what the app is, where tokens go, what it may do. */
export function consentPage(opts: {
  details: ConsentDescription;
  handle: string;
  signedInAs: string;
  /** This page's own URL, to come back to after signing in as someone else. */
  self: string;
  libraries: ReachableLibrary[];
  form: ConsentForm;
  error?: { message: string; field?: ConsentField };
}): string {
  const { details, form } = opts;
  const name = esc(details.clientName || "An app");
  const origin = details.clientDomain
    ? `Published by <strong>${esc(details.clientDomain)}</strong>.`
    : "This app registered itself; its name is not verified.";
  const bad = (field: ConsentField) => invalid(ERROR_ID, opts.error?.field === field);
  const libChecks = opts.libraries
    .map((l) => {
      const key = consentKey(l);
      const shared =
        l.role === "owner"
          ? ""
          : ` <span class="muted">shared with you, ${l.role === "read" ? "read only" : "read and write"}</span>`;
      return `<label class="choice"><input type="checkbox" name="library" value="${esc(key)}"${form.selected.includes(key) ? " checked" : ""}${bad("libraries")}> ${esc(libraryName(l))}${shared}</label>`;
    })
    .join("");
  const anyShared = opts.libraries.some((l) => l.role !== "owner");
  const radio = (field: string, value: string, current: string, label: string, hint: string) =>
    `<label class="choice"><input type="radio" name="${field}" value="${value}"${value === current ? " checked" : ""}> ${label}${hint ? ` <span class="muted">${hint}</span>` : ""}</label>`;
  // More options stay folded unless one is set or wrong.
  const more =
    form.prefix !== "" || opts.error?.field === "actor" || opts.error?.field === "prefix";
  return page(
    `Connect ${details.clientName || "an app"}`,
    `<h1>Connect ${name}</h1>
<p>${origin} Access goes to <strong>${esc(details.redirectHost)}</strong>.</p>
<form method="post" action="/sign-out"><input type="hidden" name="next" value="${esc(opts.self)}">
<p class="muted">Signed in as ${esc(opts.signedInAs)}. <button class="ghost" type="submit">Not you? Sign out</button></p></form>
${details.redirectIsLoopback ? '<p class="notice">This sends access to an app on your computer. Continue only if you just started connecting from it.</p>' : ""}
${opts.error ? alertNotice(ERROR_ID, opts.error.message) : ""}
<form method="post" class="stack">
  <input type="hidden" name="handle" value="${esc(opts.handle)}">
  <fieldset>
    <legend>Libraries</legend>
    ${radio("libraries", "all", form.libraries, "All your libraries", `including ones you create later${anyShared ? "; libraries shared with you only when picked" : ""}`)}
    ${radio("libraries", "selected", form.libraries, "Only these", "")}
    <div class="indent">${libChecks}</div>
    <label class="field">New library (optional)
    <input type="text" id="new_library" name="new_library" value="${esc(form.newLibrary)}" placeholder="team-notes" autocapitalize="off" spellcheck="false"${bad("new_library")}>
    <span class="field-hint">Connecting creates it. Leave it empty to create none.</span></label>
  </fieldset>
  <fieldset>
    <legend>Access</legend>
    ${radio("access", "read", form.access, "Read only", "")}
    ${radio("access", "write", form.access, "Read and write", "")}
    ${offersCreate(details) ? `<label class="choice"><input type="checkbox" name="create_libraries" value="on"${form.create ? " checked" : ""}${bad("create")}> Create libraries <span class="muted">owned by you; needs Read and write and All tools</span></label>` : ""}
  </fieldset>
  <fieldset>
    <legend>Tools</legend>
    ${radio("tiers", "all", form.tiers, "All tools", "")}
    ${radio("tiers", "files", form.tiers, "File tools only", "")}
  </fieldset>
  <details${more ? " open" : ""}>
  <summary>More options</summary>
  <fieldset>
    <legend>Limits and name</legend>
    <label class="field">Only this folder in each library (optional)
    <input type="text" id="prefix" name="prefix" value="${esc(form.prefix)}" placeholder="notes" autocapitalize="off" spellcheck="false"${bad("prefix")}></label>
    <label class="field">Connection name
    <input type="text" id="actor" name="actor" value="${esc(form.actor)}" autocapitalize="off" spellcheck="false"${bad("actor")}>
    <span class="field-hint">How this connection signs its changes for agents and exports, like claude/laptop.</span></label>
  </fieldset>
  </details>
  ${form.newLibrary ? `<p>Connecting creates the library <strong>${esc(form.newLibrary)}</strong>.</p>` : ""}
  <div class="actions">
    <button class="primary" name="decision" value="approve">Connect</button>
    <button class="ghost" name="decision" value="deny">Cancel</button>
  </div>
</form>`,
  );
}

/**
 * The headers every server page answers with (V-11): no script, no framing, no cache, no index,
 * and a link's secret never leaves in a Referer (form posts still carry Origin).
 */
export const PAGE_HEADERS: Readonly<Record<string, string>> = {
  "Content-Type": "text/html; charset=utf-8",
  "Content-Security-Policy":
    "default-src 'none'; style-src 'self'; font-src 'self'; img-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  "X-Frame-Options": "DENY",
  "X-Content-Type-Options": "nosniff",
  "X-Robots-Tag": "noindex",
  "Referrer-Policy": "same-origin",
  "Cache-Control": "no-store",
};

/** Where a page with nothing else to do sends the person next (V-7). */
export interface Onward {
  href: string;
  label: string;
}

export const LIBRARIES: Onward = { href: "/", label: "Go to your libraries" };

/** A server page that says one thing, with a link onward. */
export function messagePage(
  title: string,
  message: string,
  status = 200,
  onward: Onward | null = LIBRARIES,
): Response {
  const link = onward ? `<p><a href="${esc(onward.href)}">${esc(onward.label)}</a></p>` : "";
  return new Response(page(title, `<h1>${esc(title)}</h1><p>${esc(message)}</p>${link}`), {
    status,
    headers: { ...PAGE_HEADERS },
  });
}

/**
 * Whether a request that found no route, or failed, is a person's page load (V-1): it accepts
 * HTML and is not one of the service's machine endpoints (the API, MCP, OAuth's endpoints,
 * downloads, static files), which keep answering JSON.
 */
export function wantsPage(req: Request): boolean {
  const path = new URL(req.url).pathname;
  if (/^\/(api|mcp|token|register|dl|ul|_design|_app|healthz)(\/|$)/.test(path)) return false;
  if (path.startsWith("/.well-known")) return false;
  return (req.headers.get("Accept") ?? "").includes("text/html");
}
