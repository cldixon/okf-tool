import { sha256Hex } from "./format/hash";

/**
 * Agent identity (tempra-dev: decisions/agents-act-for-a-person, TEMPRA-75). An agent acts for
 * one person and is its own identity: Alice's Claude is not Alice's ChatGPT, nor Bob's Claude.
 * An agent is a person's agents on one platform, so connecting Claude from claude.ai twice is
 * one agent with two connections. Platforms come from the strongest signal at hand:
 *
 * - an app connection: the domain its sign-in returns to (claude.ai, chatgpt.com), which only
 *   that platform can receive; a client on the person's computer (a loopback redirect) or one
 *   with no domain is told apart by its self-chosen name, which is a claim, never authority;
 * - a bearer token: the app half of its actor (claude-code/laptop is claude-code).
 *
 * Nothing here authorizes anything: roles and scopes do (tenancy.ts).
 */

/** What a connecting app told us at consent. */
export interface ClientSignals {
  name?: string | null;
  domain?: string | null;
  loopback?: boolean;
}

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);

export interface AgentKey {
  platform: string;
  /** How the agent is shown: "Claude", "claude.ai", "claude-code". */
  name: string;
}

export function connectionAgent(c: ClientSignals): AgentKey {
  const name = (c.name ?? "").trim();
  if (c.domain && !c.loopback) return { platform: c.domain.toLowerCase(), name: name || c.domain };
  const where = c.loopback ? "local" : "app";
  return { platform: `${where}/${slug(name) || "unnamed"}`, name: name || "an app" };
}

export function tokenAgent(actor: string): AgentKey {
  const app = actor.startsWith("process:") ? "process" : (actor.split("/")[0] ?? "token");
  return { platform: `token/${slug(app) || "token"}`, name: app };
}

/** The agent's id: the same for the same person on the same platform, with no lookup. */
export function agentId(userId: string, platform: string): string {
  return `agt_${sha256Hex(`${userId}|${platform}`).slice(0, 24)}`;
}

/** Who a ledger event was done by, beyond its actor string: kept in the event's meta. */
export interface ActedBy {
  /** The users row id of the person, stable across handle changes. */
  person: string;
  /** The agent acting for them, when it was not the person in the app. */
  agent?: string;
}

/** How an agent is named for whom it acts, as the app's agentLabel names it: "Claude for @ann". */
export function agentName(a: { name: string; person: string }): string {
  return `${a.name} for @${a.person}`;
}
