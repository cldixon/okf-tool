import { actorAgentName, readableName } from "./agents";
import { post } from "./api";
import { libraryLabel } from "./role";
import { urlsOf } from "./urls";

/*
 * A person's notifications and their count (TEMPRA-72; one state and the bell, TEMPRA-189): the
 * items of the API's `/api/v1/inbox`, drawn by the bell's panel. An item is open until it is
 * done: opened, or answered.
 */

/**
 * What a person is told of (TEMPRA-173): an invitation, a mention and a reply; and, about their
 * account, a monthly quota at 80% and at 100% (`quota`, TEMPRA-232, the decision's addendum of
 * 2026-10-31).
 */
type InboxKind = "reply" | "mention" | "invitation" | "quota";

/** One item, as `GET /api/v1/inbox` describes it. */
export interface InboxItem {
  id: string;
  kind: InboxKind;
  /** The library as owner/slug; "" for a `quota` item, which is on the account. */
  library: string;
  library_title: string | null;
  path: string | null;
  thread: string | null;
  /** The page's title, when the item is on one. */
  title: string | null;
  actor: string;
  /** Who did it, as people read it: an agent by its name, a person by their handle. */
  who: string;
  agent: boolean;
  excerpt: string;
  /** `invitation`: the invitation to accept or decline, while it is open. */
  invitation: string | null;
  created: string;
  done_at: string | null;
  /** What the row offers: reply, resolve, open, accept, decline. */
  actions: string[];
  href: string;
}

export interface InboxPage {
  items: InboxItem[];
  next: string | null;
  open: number;
}

/** Said on window when the inbox may have changed (a comment or write on an open feed, a mark). */
export const INBOX_EVENT = "tempra:inbox";

export const inboxChanged = (): void => {
  window.dispatchEvent(new Event(INBOX_EVENT));
};

/** Marks an item done (it was opened), then tells every count to reload. */
export function markDone(id: string): Promise<void> {
  return post(`/api/v1/inbox/${encodeURIComponent(id)}/done`, {})
    .then(inboxChanged)
    .catch(() => {});
}

/** A path's last part without .md: what names a page that has no title. */
const pageName = (path: string) => path.replace(/\.md$/, "").split("/").pop() ?? path;

/**
 * The item's library as people read it (libraryLabel, TEMPRA-131): its title, else its slug;
 * the owner after it when it is not the person's own (`me` is their handle).
 */
export function itemLibrary(
  i: Pick<InboxItem, "library" | "library_title"> & { kind?: InboxKind },
  me: string | null,
): string {
  if (i.kind === "quota") return "Your account";
  const { owner, slug } = urlsOf(i.library);
  return libraryLabel({
    owner,
    slug,
    title: i.library_title,
    role: me === null || owner === me ? "owner" : "read",
  });
}

/** What the item is about: the page, or the library for an invitation or an access change. */
export function itemTitle(i: InboxItem, titles: PageTitles = {}): string {
  // A monthly quota (TEMPRA-232): "Writes this month".
  if (i.kind === "quota") return i.title || "Your account";
  if (i.path) return i.title || titles[`${i.library} ${i.path}`] || pageName(i.path);
  return i.library_title || urlsOf(i.library).slug;
}

/** Agents' names by "owner/slug actor", for items whose actor is an agent (useAgentLabels). */
export type AgentLabels = Record<string, string>;

/**
 * Who did it, as people read it (AgentName's words, TEMPRA-131): an agent named for its person
 * ("Claude Code for @dev") when the library's agents tell which one it is, else by its readable
 * name ("Claude Code", never "claude-code/local"); a person by their handle.
 */
export function itemWho(
  i: Pick<InboxItem, "who" | "actor" | "agent" | "library">,
  labels: AgentLabels = {},
): string {
  if (!i.agent) return i.who;
  const known = labels[`${i.library} ${i.actor}`];
  if (known) return known;
  return i.who === i.actor ? actorAgentName(i.actor) : readableName(i.who);
}

/** Items with `who` in people's words (itemWho), for the bell's panel. */
export const withNames = (items: InboxItem[], labels: AgentLabels): InboxItem[] =>
  items.map((i) => ({ ...i, who: itemWho(i, labels) }));

/** Pages' titles by "owner/slug path", for items the server names by path only (replies). */
export type PageTitles = Record<string, string>;

/** The item's detail line: "Claude Code replied to your thread". */
export function itemDetail(i: InboxItem): string {
  switch (i.kind) {
    case "reply":
      return `${i.who} replied to your thread`;
    case "mention":
      return `${i.who} mentioned you`;
    case "invitation":
      return `${i.who} invited you to ${/write/i.test(i.excerpt) ? "write" : "read and comment"}`;
    default:
      return i.excerpt;
  }
}

/** Where following the item leads: a thread opens in the page's Comments panel. */
export function itemHref(i: InboxItem): string {
  if (i.thread && i.path && i.kind !== "invitation") {
    return i.href.replace(/#comments$/, `#thread-${encodeURIComponent(i.thread)}`);
  }
  return i.href;
}
