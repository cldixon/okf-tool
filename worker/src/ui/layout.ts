import { esc } from "../oauth/pages";

export { esc };

const STYLE = `
:root { color-scheme: light dark; --fg: #1a1a1a; --muted: #5f6368; --line: #dcdce2; --bg: #fff;
  --panel: #f6f6f8; --accent: #2b59c3; --warn: #8a4b00; --ok: #1e7a3c; --bad: #b3261e;
  --chip: #ececf1; --code: #f1f1f4; }
@media (prefers-color-scheme: dark) { :root { --fg: #ececf1; --muted: #a0a0ab; --line: #3a3a44;
  --bg: #16161a; --panel: #1f1f25; --accent: #8fb0ff; --warn: #f0b36a; --ok: #7fd197;
  --bad: #ff8a80; --chip: #2a2a32; --code: #24242b; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg);
  font: 15px/1.55 system-ui, -apple-system, "Segoe UI", sans-serif; }
a { color: var(--accent); text-decoration: none; }
a:hover { text-decoration: underline; }
header.top { border-bottom: 1px solid var(--line); background: var(--panel); }
header.top div { max-width: 1120px; margin: 0 auto; padding: 10px 16px; display: flex; gap: 16px;
  align-items: baseline; flex-wrap: wrap; }
header.top .brand { font-weight: 700; color: var(--fg); }
header.top .who { margin-left: auto; color: var(--muted); font-size: 13px; }
main { max-width: 1120px; margin: 0 auto; padding: 20px 16px 48px; }
h1 { font-size: 24px; line-height: 1.25; margin: 4px 0 6px; overflow-wrap: anywhere; }
h2 { font-size: 17px; margin: 24px 0 8px; }
.muted { color: var(--muted); }
.small { font-size: 13px; }
.crumbs { font-size: 13px; color: var(--muted); overflow-wrap: anywhere; }
.crumbs a { color: var(--muted); }
.chips { display: flex; flex-wrap: wrap; gap: 6px; margin: 8px 0 4px; }
.chip { display: inline-block; font-size: 12px; line-height: 1.6; padding: 0 8px; border-radius: 999px;
  background: var(--chip); color: var(--fg); white-space: nowrap; }
.chip.ok { background: color-mix(in srgb, var(--ok) 18%, transparent); color: var(--ok); }
.chip.warn { background: color-mix(in srgb, var(--warn) 18%, transparent); color: var(--warn); }
.chip.bad { background: color-mix(in srgb, var(--bad) 16%, transparent); color: var(--bad); }
.notice { border: 1px solid var(--warn); color: var(--warn); border-radius: 8px; padding: 8px 12px;
  margin: 12px 0; }
.layout { display: grid; grid-template-columns: minmax(0, 1fr) 340px; gap: 32px; align-items: start; }
@media (max-width: 860px) { .layout { grid-template-columns: minmax(0, 1fr); } }
aside section { border: 1px solid var(--line); border-radius: 10px; padding: 12px 14px; margin-bottom: 14px;
  background: var(--panel); overflow-wrap: anywhere; }
aside h2 { margin: 0 0 8px; font-size: 14px; text-transform: uppercase; letter-spacing: .04em;
  color: var(--muted); }
aside ul { margin: 0; padding-left: 18px; }
aside li { margin: 4px 0; }
dl.fm { margin: 0; display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 4px 12px;
  font-size: 13px; }
dl.fm dt { color: var(--muted); }
dl.fm dd { margin: 0; }
.body { overflow-wrap: anywhere; margin-top: 12px; }
.body > :first-child { margin-top: 0; }
aside pre.src { white-space: pre-wrap; margin: 0; padding: 8px; font-size: 12px; }
.body pre, pre.src { background: var(--code); padding: 12px; border-radius: 8px; overflow-x: auto; }
.body code, pre.src { font: 13px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; }
.body :not(pre) > code { background: var(--code); padding: 1px 4px; border-radius: 4px; }
.body code.raw-html { color: var(--muted); }
.body img { max-width: 100%; }
.body blockquote { margin: 0; padding-left: 14px; border-left: 3px solid var(--line); color: var(--muted); }
.body table, table.list { border-collapse: collapse; width: 100%; font-size: 14px; }
.body th, .body td, table.list th, table.list td { text-align: left; padding: 6px 8px;
  border-bottom: 1px solid var(--line); vertical-align: top; }
.table-wrap { overflow-x: auto; }
table.list td.name { overflow-wrap: anywhere; }
sup.fnref { font-size: 11px; }
ul.lint li { color: var(--warn); }
form.inline { display: flex; gap: 8px; align-items: center; margin: 8px 0; flex-wrap: wrap; }
input[type=number], input[type=text] { padding: 5px 8px; border: 1px solid var(--line); border-radius: 6px;
  background: var(--bg); color: var(--fg); font: inherit; width: 110px; }
button { font: inherit; padding: 5px 12px; border-radius: 6px; border: 1px solid var(--line);
  background: var(--bg); color: var(--fg); cursor: pointer; }
ol.history { list-style: none; padding: 0; margin: 0; font-size: 13px; }
ol.history li { padding: 4px 0; border-bottom: 1px solid var(--line); }
ol.history li.current { font-weight: 600; }
.stats { display: flex; gap: 20px; flex-wrap: wrap; margin: 12px 0; }
.stats div { font-size: 13px; color: var(--muted); }
.stats strong { display: block; font-size: 20px; color: var(--fg); }
`;

export interface Shell {
  title: string;
  /** Signed-in email, shown in the header. */
  user: string;
  body: string;
}

export function layout(s: Shell): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(s.title)}</title><style>${STYLE}</style></head>
<body><header class="top"><div><a class="brand" href="/app">OKF</a>
<a href="/app">Libraries</a><a href="/app/grants">Connected apps</a>
<span class="who">${esc(s.user)}</span></div></header>
<main>${s.body}</main></body></html>`;
}

/** Security headers for every UI page: no scripts at all, images from here or https. */
export function htmlResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy":
        "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' https:; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
      "X-Frame-Options": "DENY",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "same-origin",
      "Cache-Control": "no-store",
    },
  });
}

export function chip(text: string, tone: "" | "ok" | "warn" | "bad" = "", title?: string) {
  const t = title ? ` title="${esc(title)}"` : "";
  return `<span class="chip${tone ? ` ${tone}` : ""}"${t}>${esc(text)}</span>`;
}

export function trustChip(tier: string | undefined): string {
  if (tier === "human-reviewed")
    return chip("human-reviewed", "ok", "A human verified this version");
  if (tier === "machine-confirmed")
    return chip("machine-confirmed", "", "A process re-checked this version");
  return chip("unverified", "warn", "Nobody has verified this version");
}

/** A compact UTC timestamp: 2026-09-29 18:02. */
export function when(iso: string): string {
  return iso
    .replace("T", " ")
    .replace(/:\d\d(\.\d+)?Z$/, "")
    .replace(/Z$/, "");
}
