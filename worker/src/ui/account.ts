import type { User } from "../accounts";
import type { SessionInfo } from "../session";
import { esc, when } from "./layout";
import type { Urls } from "./views";

/**
 * First run, connecting an agent, the account page and deletion (v2 spec: Onboarding, A2).
 * Plain HTML with browser defaults, as little text as works (v2 spec: UI rule for Phase A).
 */

export const SKILL_URL = "https://github.com/cldixon/okf-tool/blob/main/skills/okf/SKILL.md";

const err = (e?: string) => (e ? `<p><strong>${esc(e)}</strong></p>` : "");

export function welcomePage(opts: {
  handle: string;
  library: string;
  starter: boolean;
  error?: string;
}): string {
  return `<h1>Welcome</h1>
${err(opts.error)}
<form method="post" action="/app/welcome">
<p><label>Handle <input type="text" name="handle" value="${esc(opts.handle)}" required></label></p>
<p><label>First library <input type="text" name="library" value="${esc(opts.library)}" required></label></p>
<p><label><input type="checkbox" name="starter" value="1"${opts.starter ? " checked" : ""}> Add a start-here note</label></p>
<p><button type="submit">Create</button></p>
</form>`;
}

/** The starter concept a first library may begin with. */
export const STARTER = `---
type: Guide
title: Start here
description: What this library is and how to add to it.
---
This library holds concepts: one markdown file per idea, with YAML frontmatter.

Connect an agent, then ask it to read this note and add what you know.
`;

export interface AgentWrite {
  actor: string;
  ts: string;
  note: string | null;
}

export function connectPage(opts: { urls: Urls; mcp: string; latest: AgentWrite | null }): string {
  const { urls } = opts;
  const status = opts.latest
    ? `Last agent write: ${esc(opts.latest.actor)}, ${esc(when(opts.latest.ts))} UTC${opts.latest.note ? `, "${esc(opts.latest.note)}"` : ""}. <a href="${esc(urls.ledger())}">Ledger</a>`
    : `No agent has written yet. <a href="${esc(urls.connect())}">Refresh</a>`;
  return `<h1>Connect an agent</h1>
<h2>claude.ai</h2>
<p>Add a custom connector with this URL, then pick ${esc(urls.slug)} when asked.</p>
<pre>${esc(opts.mcp)}</pre>
<h2>Claude Code</h2>
<pre>claude mcp add --transport http okf ${esc(opts.mcp)}</pre>
<p>Then run /mcp in Claude Code to sign in.</p>
<h2>Other clients</h2>
<p><a href="/app/tokens?library=${esc(encodeURIComponent(urls.slug))}">Create a token</a></p>
<h2>Skill</h2>
<p><a href="${SKILL_URL}">SKILL.md</a></p>
<h2>Status</h2>
<p id="status">${status}</p>`;
}

export function accountPage(opts: {
  user: User;
  sessions: SessionInfo[];
  current: string | null;
  notice?: string;
  error?: string;
}): string {
  const { user } = opts;
  const rows = opts.sessions
    .map(
      (
        s,
      ) => `<tr><td>${esc(when(s.created))}</td><td>${esc(when(s.last_seen))}</td><td>${esc(s.user_agent ?? "")}</td>
<td>${
        s.id === opts.current
          ? "this device"
          : `<form method="post" action="/app/account/sessions/end"><input type="hidden" name="id" value="${esc(s.id)}"><button type="submit">Sign out</button></form>`
      }</td></tr>`,
    )
    .join("");
  return `<h1>Account</h1>
${opts.notice ? `<p>${esc(opts.notice)}</p>` : ""}${err(opts.error)}
<p>${esc(user.email)}</p>
<form method="post" action="/app/account/handle">
<p><label>Handle <input type="text" name="handle" value="${esc(user.handle)}" required></label> <button type="submit">Change</button></p>
</form>
<p>Actor: ${esc(user.actor)}</p>
<h2>Sessions</h2>
<table><tr><th>Started</th><th>Last seen</th><th>Device</th><th></th></tr>${rows}</table>
<form method="post" action="/app/sign-out"><button type="submit">Sign out</button></form>
<form method="post" action="/app/sign-out/everywhere"><button type="submit">Sign out everywhere</button></form>
<h2>Delete account</h2>
<p>Deletes every library you own. Export them first.</p>
<form method="post" action="/app/account/delete">
<p><label>Type ${esc(user.handle)} to confirm <input type="text" name="confirm" autocomplete="off" required></label></p>
<p><button type="submit">Delete account</button></p>
</form>`;
}

export function deleteLibraryPage(opts: { urls: Urls; error?: string }): string {
  const { urls } = opts;
  return `<h1>Delete ${esc(urls.slug)}</h1>
${err(opts.error)}
<p>Deletes every concept, attachment, export and token of this library. <a href="${esc(urls.exportTar())}">Export it first</a>.</p>
<form method="post" action="${esc(urls.remove())}">
<p><label>Type ${esc(urls.slug)} to confirm <input type="text" name="confirm" autocomplete="off" required></label></p>
<p><button type="submit">Delete library</button></p>
</form>`;
}
