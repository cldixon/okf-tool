import { formatSize, type Me } from "../ui";

/*
 * The account's pages (TEMPRA-14; take 4): first run, Agents, Invitations and Account. The pure parts they share; each page is its own component beside this file.
 */

/** The landing page's legal pages (TEMPRA-14). */
export const LEGAL = "https://tempra.dev";

// ---------------------------------------------------------------- agents

export interface TokenRow {
  id: string;
  library: string;
  actor: string;
  scope: string;
  prefix: string | null;
  expires: string | null;
  mcp_tiers: string;
  created_by: string | null;
  revoked: string | null;
}

export interface Minted {
  secret: string;
  actor: string;
  library: string;
}

/** Apps connected over OAuth (claude.ai, Claude Code) and what each may reach. */
export interface AppGrant {
  id: string;
  app: string;
  actor: string | null;
  libraries: "all" | string[];
  access: "read" | "write";
  prefix: string | null;
  tiers: "all" | "files";
  /** May create libraries owned by the person (TEMPRA-100). */
  create_libraries?: boolean;
  created: string;
}

/** A token that can act now: not revoked, not expired. */
export const liveToken = (t: TokenRow, now: number) =>
  !t.revoked && (t.expires === null || Date.parse(t.expires) > now);

/**
 * The library New token starts on: `?library=` (owner/slug) when the person may mint on it (their
 * own libraries are listed by slug alone), else the first.
 */
export function chosenLibrary(
  libraries: string[],
  library: string | null,
  me: Me | null,
): string | undefined {
  if (!library) return libraries[0];
  if (libraries.includes(library)) return library;
  const own =
    me && library.startsWith(`${me.handle}/`) ? library.slice(me.handle.length + 1) : null;
  return own && libraries.includes(own) ? own : libraries[0];
}

// ---------------------------------------------------------------- invitations

export interface PendingInvitation {
  id: string;
  owner: string;
  slug: string;
  /** The library's title, if it has one. */
  title?: string | null;
  role: "read" | "write";
  /** Who invited. */
  handle: string;
  created?: string;
  expires: string;
}

// ---------------------------------------------------------------- the account page

export interface AccountData {
  email: string;
  handle: string;
  /** The account's name, or null (TEMPRA-54). */
  name: string | null;
  actor: string;
  sessions: {
    id: string;
    created: string;
    last_seen: string;
    user_agent: string | null;
    current: boolean;
  }[];
  usage: { libraries: number; tokens: number };
  limits: { libraries: number; tokens: number };
  /** This month against the monthly quotas (TEMPRA-232); null when it could not be read. */
  month?: MonthUsage | null;
}

/** An account's month against its quotas, as `GET /api/v1/account` answers it. */
export interface MonthUsage {
  month: string;
  /** When the month's counts start again: the first of the next, 00:00 UTC. */
  resets: string;
  writes: { used: number; limit: number };
  requests: { used: number; limit: number };
  /** Bytes across the libraries the account owns. */
  storage: { used: number; limit: number };
}

/**
 * The month's usage as the Account page says it: what each quota is called and "1,203 of
 * 100,000" (storage in its own units, which do not reset).
 */
export function monthLines(m: MonthUsage): { label: string; text: string }[] {
  const n = (x: number) => x.toLocaleString("en-US");
  return [
    { label: "Writes this month", text: `${n(m.writes.used)} of ${n(m.writes.limit)}` },
    {
      label: "Tool calls and API requests this month",
      text: `${n(m.requests.used)} of ${n(m.requests.limit)}`,
    },
    {
      label: "Storage",
      text: `${formatSize(m.storage.used)} of ${formatSize(m.storage.limit)}`,
    },
  ];
}

export const DONE: Record<string, string> = {
  email: "Your email is changed.",
};

// ---------------------------------------------------------------- notification mail

/** The one email switch (TEMPRA-189): mentions and replies by email, or not. */
export interface MailPrefs {
  email: boolean;
}
