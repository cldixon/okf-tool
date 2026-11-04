/** What every page of the site shares: where the app is, the name, and who to write to. */

/**
 * The app, where people sign in and request access: the same host since TEMPRA-276 (the app's
 * Worker serves tempra.dev and shows this site at `/` to people signed out), so links are paths.
 */
export const APP = "";

export const SITE_NAME = "Tempra";

/**
 * Where people write about their account, their data or these terms. TODO(owner): confirm this
 * mailbox receives mail before the site ships (TEMPRA-126).
 */
export const CONTACT = "hello@tempra.dev";

/** The pages a search engine should know, as the sitemap lists them (no trailing slash). */
export const PAGES = ["/", "/terms", "/privacy"] as const;

/** When Terms and Privacy last changed, shown at the top of each. */
export const LEGAL_UPDATED = { iso: "2026-11-03", text: "3 November 2026" } as const;

/** What deleting does, word for word the same on Terms and Privacy. */
export const DELETION =
  "Deleting a library or your account removes it at once. Backups and attached files can last up to 31 more days, then they are gone. We keep a hash of a deleted account's email address to handle abuse.";
