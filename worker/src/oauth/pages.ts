import type { ConsentDescription, GrantSummary } from "@cloudflare/workers-oauth-provider";
import type { LibraryRef } from "../accounts";

/** Escapes text for HTML; every client-supplied string passes through here. */
export const esc = (value: string) => value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const STYLE = `
:root { color-scheme: light dark; --fg: #1a1a1a; --muted: #5f6368; --line: #d9d9de; --bg: #fff;
  --panel: #f6f6f8; --accent: #2b59c3; --warn: #8a4b00; }
@media (prefers-color-scheme: dark) { :root { --fg: #ececf1; --muted: #a0a0ab; --line: #3a3a44;
  --bg: #16161a; --panel: #1f1f25; --accent: #8fb0ff; --warn: #f0b36a; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg);
  font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width: 560px; margin: 0 auto; padding: 32px 16px 48px; }
h1 { font-size: 22px; margin: 0 0 4px; }
.muted { color: var(--muted); }
.panel { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 16px; margin: 16px 0; }
.warn { color: var(--warn); font-weight: 600; }
fieldset { border: 0; padding: 0; margin: 0 0 16px; }
legend, label.field { font-weight: 600; display: block; margin-bottom: 6px; }
input[type=text], select { width: 100%; padding: 8px 10px; border: 1px solid var(--line);
  border-radius: 8px; background: var(--bg); color: var(--fg); font: inherit; }
.choice { display: flex; gap: 8px; align-items: baseline; margin: 4px 0; font-weight: 400; }
.hint { font-size: 13px; color: var(--muted); margin-top: 4px; }
.actions { display: flex; gap: 12px; margin-top: 24px; }
button { font: inherit; padding: 9px 18px; border-radius: 8px; border: 1px solid var(--line);
  background: var(--bg); color: var(--fg); cursor: pointer; }
button.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
.error { border-color: var(--warn); color: var(--warn); }
table { width: 100%; border-collapse: collapse; font-size: 14px; }
th, td { text-align: left; padding: 8px 6px; border-bottom: 1px solid var(--line); vertical-align: top; }
code { font-size: 13px; }
`;

export function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title><style>${STYLE}</style></head>
<body><main>${body}</main></body></html>`;
}

export interface ConsentForm {
  library: string;
  newLibrary: string;
  access: "read" | "write";
  prefix: string;
  actor: string;
  tiers: "all" | "files";
}

/** The consent page (spec: Apps under Auth): what the app is, where tokens go, what it may do. */
export function consentPage(opts: {
  details: ConsentDescription;
  handle: string;
  signedInAs: string;
  libraries: LibraryRef[];
  form: ConsentForm;
  error?: string;
}): string {
  const { details, form } = opts;
  const name = esc(details.clientName || "An app");
  const origin = details.clientDomain
    ? `Published by <strong>${esc(details.clientDomain)}</strong>.`
    : "This app registered itself; its name is not verified.";
  const libOptions = opts.libraries
    .map(
      (l) =>
        `<option value="${esc(l.slug)}"${l.slug === form.library ? " selected" : ""}>${esc(l.slug)}</option>`,
    )
    .join("");
  const radio = (field: string, value: string, current: string, label: string, hint: string) =>
    `<label class="choice"><input type="radio" name="${field}" value="${value}"${value === current ? " checked" : ""}> <span>${label}<br><span class="hint">${hint}</span></span></label>`;
  return page(
    `Connect ${details.clientName || "an app"}`,
    `<h1>Connect ${name} to a library</h1>
<p class="muted">Signed in as ${esc(opts.signedInAs)}.</p>
<div class="panel">
  <p>${origin}</p>
  <p>Access will be sent to <strong>${esc(details.redirectHost)}</strong>.</p>
  ${details.redirectIsLoopback ? '<p class="warn">This sends access to an app on your computer. Continue only if you just started connecting from it.</p>' : ""}
</div>
${opts.error ? `<div class="panel error">${esc(opts.error)}</div>` : ""}
<form method="post">
  <input type="hidden" name="handle" value="${esc(opts.handle)}">
  <fieldset>
    <label class="field" for="library">Library</label>
    <select id="library" name="library">
      ${libOptions}
      <option value=""${form.library === "" ? " selected" : ""}>New library…</option>
    </select>
    <input type="text" name="new_library" value="${esc(form.newLibrary)}" placeholder="name for a new library, e.g. team-notes" aria-label="New library name" style="margin-top:8px">
    <div class="hint">Each connection reaches one library. To use two, connect the app twice.</div>
  </fieldset>
  <fieldset>
    <legend>Access</legend>
    ${radio("access", "read", form.access, "Read only", "Browse, read, search and history. No changes.")}
    ${radio("access", "write", form.access, "Read and write", "Also create, edit, move, delete and revert. Every change is attributed to this app.")}
  </fieldset>
  <fieldset>
    <label class="field" for="prefix">Limit writes to a directory (optional)</label>
    <input type="text" id="prefix" name="prefix" value="${esc(form.prefix)}" placeholder="e.g. notes">
  </fieldset>
  <fieldset>
    <label class="field" for="actor">Name in the ledger</label>
    <input type="text" id="actor" name="actor" value="${esc(form.actor)}">
    <div class="hint">How this app's changes are attributed, as &lt;app&gt;/&lt;label&gt;, e.g. claude-ai/connector.</div>
  </fieldset>
  <fieldset>
    <legend>Tools</legend>
    ${radio("tiers", "all", form.tiers, "All tools", "File tools plus search, history, diff, revert and the work queue.")}
    ${radio("tiers", "files", form.tiers, "File tools only", "Read, write, edit, grep, move and delete, as on a local folder.")}
  </fieldset>
  <div class="actions">
    <button class="primary" name="decision" value="approve">Connect</button>
    <button name="decision" value="deny">Cancel</button>
  </div>
</form>`,
  );
}

export function grantsPage(opts: {
  signedInAs: string;
  grants: GrantSummary[];
  clientNames: Map<string, string>;
  notice?: string;
}): string {
  const rows = opts.grants
    .map((g) => {
      const m = (g.metadata ?? {}) as Record<string, string | null>;
      const app = opts.clientNames.get(g.clientId) ?? g.clientId;
      return `<tr>
  <td>${esc(app)}<br><span class="hint">${esc(m.actor ?? "")}</span></td>
  <td>${esc(m.library ?? "")}${m.prefix ? `<br><span class="hint">under ${esc(m.prefix)}/</span>` : ""}</td>
  <td>${m.access === "write" ? "Read and write" : "Read only"}${m.tiers === "files" ? '<br><span class="hint">file tools only</span>' : ""}</td>
  <td>${new Date(g.createdAt * 1000).toISOString().slice(0, 10)}</td>
  <td><form method="post" action="/app/grants/revoke"><input type="hidden" name="grant" value="${esc(g.id)}"><button>Revoke</button></form></td>
</tr>`;
    })
    .join("");
  return page(
    "Connected apps",
    `<h1>Connected apps</h1>
<p class="muted">Signed in as ${esc(opts.signedInAs)}. Revoking a connection stops its tokens at once; the app must be connected again to use the library.</p>
${opts.notice ? `<div class="panel">${esc(opts.notice)}</div>` : ""}
${
  opts.grants.length === 0
    ? '<div class="panel">No apps are connected yet. Add this server as a connector in claude.ai or ChatGPT and approve it here.</div>'
    : `<table><thead><tr><th>App</th><th>Library</th><th>Access</th><th>Since</th><th></th></tr></thead><tbody>${rows}</tbody></table>`
}`,
  );
}

export function messagePage(title: string, message: string, status = 200) {
  return new Response(page(title, `<h1>${esc(title)}</h1><p>${esc(message)}</p>`), {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8", "X-Frame-Options": "DENY" },
  });
}
