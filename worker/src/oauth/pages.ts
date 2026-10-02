import type { ConsentDescription, GrantSummary } from "@cloudflare/workers-oauth-provider";
import type { LibraryRef } from "../accounts";

/** Escapes text for HTML; every client-supplied string passes through here. */
export const esc = (value: string) => value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title></head>
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
    `<label><input type="radio" name="${field}" value="${value}"${value === current ? " checked" : ""}> ${label}</label>${hint ? ` <small>${hint}</small>` : ""}<br>`;
  return page(
    `Connect ${details.clientName || "an app"}`,
    `<h1>Connect ${name} to a library</h1>
<p>Signed in as ${esc(opts.signedInAs)}. ${origin} Access goes to <strong>${esc(details.redirectHost)}</strong>.</p>
${details.redirectIsLoopback ? "<p><strong>This sends access to an app on your computer. Continue only if you just started connecting from it.</strong></p>" : ""}
${opts.error ? `<p><strong>${esc(opts.error)}</strong></p>` : ""}
<form method="post">
  <input type="hidden" name="handle" value="${esc(opts.handle)}">
  <fieldset>
    <label class="field" for="library">Library</label>
    <select id="library" name="library">
      ${libOptions}
      <option value=""${form.library === "" ? " selected" : ""}>New library…</option>
    </select>
    <input type="text" name="new_library" value="${esc(form.newLibrary)}" placeholder="name for a new library, e.g. team-notes" aria-label="New library name">
  </fieldset>
  <fieldset>
    <legend>Access</legend>
    ${radio("access", "read", form.access, "Read only", "")}
    ${radio("access", "write", form.access, "Read and write", "")}
  </fieldset>
  <fieldset>
    <label class="field" for="prefix">Limit writes to a directory (optional)</label>
    <input type="text" id="prefix" name="prefix" value="${esc(form.prefix)}" placeholder="e.g. notes">
  </fieldset>
  <fieldset>
    <label class="field" for="actor">Name in the ledger</label>
    <input type="text" id="actor" name="actor" value="${esc(form.actor)}">
  </fieldset>
  <fieldset>
    <legend>Tools</legend>
    ${radio("tiers", "all", form.tiers, "All tools", "")}
    ${radio("tiers", "files", form.tiers, "File tools only", "")}
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
<p>Signed in as ${esc(opts.signedInAs)}.</p>
${opts.notice ? `<p>${esc(opts.notice)}</p>` : ""}
${
  opts.grants.length === 0
    ? "<p>None.</p>"
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
