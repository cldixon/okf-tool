import { stringify as yamlStringify } from "yaml";
import type { Json, JsonObject, LintWarning } from "../okf/types";
import { chip, esc, trustChip, when } from "./layout";
import { renderBody } from "./markdown";

/** URLs of the UI pages for one library, optionally pinned to a sequence (spec: Built-in UI). */
export class Urls {
  readonly base: string;
  constructor(
    readonly slug: string,
    readonly at?: number,
  ) {
    this.base = `/app/libraries/${encodeURIComponent(slug)}/`;
  }
  private q(extra?: string) {
    const parts = [this.at === undefined ? "" : `at=${this.at}`, extra ?? ""].filter(Boolean);
    return parts.length ? `?${parts.join("&")}` : "";
  }
  pinned(at: number | undefined) {
    return new Urls(this.slug, at);
  }
  tree(dir: string) {
    return dir === "" ? `${this.base}${this.q()}` : `${this.base}tree/${enc(dir)}/${this.q()}`;
  }
  file(path: string, anchor: string | null = null) {
    return `${this.base}files/${enc(path)}${this.q()}${anchor ?? ""}`;
  }
  raw(path: string) {
    return `${this.base}raw/${enc(path)}${this.q()}`;
  }
  download(path: string) {
    return `${this.base}download/${enc(path)}${this.q()}`;
  }
  /** A diff of a concept between two sequences; either end may be left to the server. */
  diff(path: string, from?: number, to?: number) {
    return `${this.base}diff/${enc(path)}${query({ from, to })}`;
  }
  ledger(filters: LedgerFilters = {}) {
    return `${this.base}ledger${query({ ...filters })}`;
  }
  revert(requestId: string) {
    return `${this.base}revert/${encodeURIComponent(requestId)}`;
  }
  restore(path: string, to: number) {
    return `${this.base}restore/${enc(path)}${query({ to })}`;
  }
}

export interface LedgerFilters {
  prefix?: string;
  actor?: string;
  from?: string;
  to?: string;
  before?: number;
}

function query(params: Record<string, string | number | undefined>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== "") q.set(k, String(v));
  }
  const s = q.toString();
  return s ? `?${s}` : "";
}

/** The library's section tabs: its files and its ledger. */
export function libNav(urls: Urls, active: "files" | "ledger"): string {
  const tab = (name: string, href: string, on: boolean) =>
    on ? `<strong>${name}</strong>` : `<a href="${esc(href)}">${name}</a>`;
  return `<nav class="libnav"><span class="muted">${esc(urls.slug)}:</span> ${tab("Files", urls.pinned(undefined).tree(""), active === "files")} · ${tab("Ledger", urls.ledger(), active === "ledger")}</nav>`;
}

/**
 * The body without a leading `# Heading` that repeats the title: agents often open a body with
 * the title, and the page already shows it. Display only; the stored body is unchanged.
 */
export function withoutTitleHeading(body: string, title: string): string {
  const m = /^\s*#[ \t]+(.+?)[ \t]*#*[ \t]*(?:\r?\n|$)/.exec(body);
  if (!m || m[1]?.trim().toLowerCase() !== title.trim().toLowerCase()) return body;
  return body.slice(m[0].length);
}

const enc = (p: string) => p.split("/").map(encodeURIComponent).join("/");

/** An element id for a footnote label or source id. */
export const anchorId = (prefix: string, label: string) =>
  `${prefix}-${label.replace(/[^\w.-]/g, "_")}`;

function dirOf(path: string) {
  const i = path.lastIndexOf("/");
  return i === -1 ? "" : path.slice(0, i);
}

function baseName(path: string) {
  return path.slice(path.lastIndexOf("/") + 1);
}

/** Breadcrumbs from the library root to `path` (a directory, or a file when `file` is set). */
export function crumbs(urls: Urls, path: string, file: boolean): string {
  const parts = path === "" ? [] : path.split("/");
  const out = [`<a href="${esc(urls.tree(""))}">${esc(urls.slug)}</a>`];
  parts.forEach((seg, i) => {
    const p = parts.slice(0, i + 1).join("/");
    const last = i === parts.length - 1;
    if (last && file) out.push(esc(seg));
    else out.push(`<a href="${esc(urls.tree(p))}">${esc(seg)}</a>`);
  });
  return `<div class="crumbs">${out.join(" / ")}</div>`;
}

function atNotice(urls: Urls, head: number, currentUrl: string): string {
  if (urls.at === undefined || urls.at >= head) return "";
  return `<div class="notice">Viewing as of sequence ${urls.at} (head is ${head}). <a href="${esc(currentUrl)}">View current</a></div>`;
}

// ---------------------------------------------------------------- library list

export interface LibrarySummary {
  slug: string;
  seq: number;
  concepts: number;
  attachments: number;
  open_work: number;
  types: Record<string, number>;
}

export function libraryList(libs: LibrarySummary[]): string {
  if (libs.length === 0) {
    return `<h1>Libraries</h1><p class="muted">No libraries yet. One is created when you connect an app and choose a new library, or with <code>bun run seed</code>.</p>`;
  }
  const rows = libs
    .map(
      (
        l,
      ) => `<tr><td class="name"><a href="/app/libraries/${esc(encodeURIComponent(l.slug))}/"><strong>${esc(l.slug)}</strong></a></td>
<td>${l.concepts}</td><td>${l.attachments}</td><td>${l.open_work ? chip(`${l.open_work} open`, "warn") : chip("none", "ok")}</td><td class="muted">${l.seq}</td></tr>`,
    )
    .join("");
  return `<h1>Libraries</h1>
<div class="table-wrap"><table class="list"><thead><tr><th>Library</th><th>Concepts</th><th>Attachments</th><th>Work queue</th><th>Seq</th></tr></thead>
<tbody>${rows}</tbody></table></div>`;
}

// ---------------------------------------------------------------- directory

export interface TreeEntry {
  path: string;
  kind: "concept" | "attachment" | "dir";
  files?: number;
  type?: string;
  title?: string | null;
  description?: string | null;
  status?: string;
  trust_tier?: string;
  stale?: boolean;
  size?: number;
  media?: string | null;
}

export function directoryPage(opts: {
  urls: Urls;
  dir: string;
  head: number;
  entries: TreeEntry[];
  summary?: LibrarySummary;
}): string {
  const { urls, dir } = opts;
  const dirs = opts.entries.filter((e) => e.kind === "dir");
  const concepts = opts.entries.filter((e) => e.kind === "concept");
  const attachments = opts.entries.filter((e) => e.kind === "attachment");
  const title = dir === "" ? urls.slug : `${baseName(dir)}/`;

  let stats = "";
  if (opts.summary) {
    const s = opts.summary;
    const types = Object.entries(s.types)
      .sort((a, b) => b[1] - a[1])
      .map(([t, n]) => chip(`${t} · ${n}`))
      .join("");
    stats = `<div class="stats"><div><strong>${s.concepts}</strong>concepts</div>
<div><strong>${s.attachments}</strong>attachments</div>
<div><strong>${s.open_work}</strong>open work items</div>
<div><strong>${s.seq}</strong>ledger sequence</div></div>
${types ? `<div class="chips">${types}</div>` : ""}`;
  }

  const dirRows = dirs
    .map(
      (d) =>
        `<tr><td class="name"><a href="${esc(urls.tree(d.path))}"><strong>${esc(baseName(d.path))}/</strong></a></td><td class="muted" colspan="2">${d.files} file${d.files === 1 ? "" : "s"}</td></tr>`,
    )
    .join("");
  const conceptRows = concepts
    .map((c) => {
      const chips = [
        trustChip(c.trust_tier),
        c.stale ? chip("stale", "bad") : "",
        c.status && c.status !== "stable" ? chip(c.status, "warn") : "",
      ].join("");
      return `<tr><td class="name"><a href="${esc(urls.file(c.path))}"><strong>${esc(c.title || baseName(c.path))}</strong></a>
<div class="small muted">${esc(baseName(c.path))}${c.description ? ` · ${esc(c.description)}` : ""}</div></td>
<td>${c.type ? chip(c.type) : chip("no type", "bad")}</td><td><div class="chips">${chips}</div></td></tr>`;
    })
    .join("");
  const attachmentRows = attachments
    .map(
      (a) =>
        `<tr><td class="name"><a href="${esc(urls.file(a.path))}">${esc(baseName(a.path))}</a></td><td class="muted">${esc(a.media ?? "file")}</td><td class="muted">${formatSize(a.size ?? 0)}</td></tr>`,
    )
    .join("");
  const empty =
    opts.entries.length === 0
      ? `<p class="muted">Nothing here${urls.at ? " at this sequence" : ""}.</p>`
      : "";

  return `${crumbs(urls, dir, false)}
<h1>${esc(title)}</h1>
${atNotice(urls, opts.head, urls.pinned(undefined).tree(dir))}
${stats}
${empty}
${dirRows || conceptRows ? `<div class="table-wrap"><table class="list"><tbody>${dirRows}${conceptRows}</tbody></table></div>` : ""}
${attachmentRows ? `<h2>Attachments</h2><div class="table-wrap"><table class="list"><tbody>${attachmentRows}</tbody></table></div>` : ""}
<p class="small muted"><a href="${esc(urls.raw(dir === "" ? "index.md" : `${dir}/index.md`))}">index.md</a> as agents see it</p>`;
}

export function formatSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

// ---------------------------------------------------------------- concept

export interface ConceptData {
  path: string;
  seq: number;
  hash: string;
  body: string;
  frontmatter: JsonObject;
  lint: LintWarning[];
  trust_tier: string;
  stale: boolean;
}

export interface SourcesData {
  sources: JsonObject[];
  unmatched_footnotes: string[];
}

export interface LinksData {
  inbound: { path: string; raw: string; kind: string }[];
  broken: { raw: string; path: string; kind: string }[];
}

export interface HistoryEvent {
  seq: number;
  ts: string;
  actor: string;
  op: string;
  path: string;
  hash: string | null;
  meta: JsonObject | null;
}

export function conceptPage(opts: {
  urls: Urls;
  head: number;
  concept: ConceptData;
  sources: SourcesData;
  links: LinksData;
  history: HistoryEvent[];
  /** Maps a body link or image to a URL. */
  url(target: string, kind: "link" | "image"): string | null;
}): string {
  const { urls, concept: c } = opts;
  const fm = c.frontmatter;
  const sourceIds = new Set(
    opts.sources.sources.map((s) => s.id).filter((id): id is string => typeof id === "string"),
  );
  const title = typeof fm.title === "string" && fm.title ? fm.title : baseName(c.path);
  const rendered = renderBody(withoutTitleHeading(c.body, title), {
    url: opts.url,
    footnote: (label, defined) =>
      sourceIds.has(label)
        ? `#${anchorId("src", label)}`
        : defined
          ? `#${anchorId("fn", label)}`
          : null,
  });

  const status = typeof fm.status === "string" ? fm.status : "stable";
  const chips = [
    typeof fm.type === "string" && fm.type ? chip(fm.type) : chip("no type", "bad"),
    trustChip(c.trust_tier),
    c.stale ? chip("stale", "bad", `stale_after ${String(fm.stale_after)}`) : "",
    status !== "stable" ? chip(status, "warn") : "",
    c.lint.length ? chip(`${c.lint.length} lint`, "warn") : "",
  ].join("");
  const current = urls.pinned(undefined).file(c.path);

  const lint = c.lint.length
    ? `<h2 id="lint">Lint</h2><ul class="lint">${c.lint.map((l) => `<li><code>${esc(l.code)}</code> ${esc(l.message)}</li>`).join("")}</ul>`
    : "";

  const main = `${crumbs(urls, c.path, true)}
<h1>${esc(title)}</h1>
${typeof fm.description === "string" ? `<p class="muted">${esc(fm.description)}</p>` : ""}
<div class="chips">${chips}</div>
${atNotice(urls, opts.head, current)}
<article class="body">${rendered.html}</article>
${lint}`;

  const aside = [
    frontmatterPanel(fm),
    sourcesPanel(urls, opts.sources, rendered.footnotes),
    linksPanel(urls, opts.links, opts.head),
    historyPanel(urls, c, opts.head, opts.history),
  ].join("");

  return `<div class="layout"><div>${main}</div><aside>${aside}</aside></div>`;
}

function scalar(v: Json): string {
  if (v === null) return '<span class="muted">null</span>';
  if (typeof v === "string") {
    return /^https?:\/\//i.test(v)
      ? `<a href="${esc(v)}" rel="noopener noreferrer nofollow">${esc(v)}</a>`
      : esc(v);
  }
  return esc(String(v));
}

/** `{ by, at }` as "by … · at …". */
function stamp(v: Json): string | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const keys = Object.keys(v);
  if (!keys.every((k) => k === "by" || k === "at")) return null;
  return `${esc(String(v.by ?? ""))}<div class="small muted">${esc(when(String(v.at ?? "")))}</div>`;
}

function frontmatterPanel(fm: JsonObject): string {
  const rows = Object.entries(fm)
    .map(([k, v]) => {
      let value: string;
      const stamps = Array.isArray(v) ? v.map(stamp) : [stamp(v)];
      if (k === "sources" && Array.isArray(v)) {
        value = `<a href="#sources">${v.length} source${v.length === 1 ? "" : "s"}</a>`;
      } else if (stamps.length > 0 && stamps.every((x) => x !== null)) {
        value = stamps.join("");
      } else if (Array.isArray(v) && v.every((x) => x === null || typeof x !== "object")) {
        value = v.map((x) => scalar(x)).join(", ");
      } else if (v !== null && typeof v === "object") {
        value = `<pre class="src">${esc(yamlStringify(v).trimEnd())}</pre>`;
      } else value = scalar(v);
      return `<dt>${esc(k)}</dt><dd>${value}</dd>`;
    })
    .join("");
  return `<section><h2>Frontmatter</h2><dl class="fm">${rows}</dl></section>`;
}

function sourcesPanel(urls: Urls, data: SourcesData, footnotes: Map<string, string>): string {
  const used = new Set<string>();
  const items = data.sources.map((s) => {
    const id = typeof s.id === "string" ? s.id : null;
    const name = typeof s.title === "string" ? s.title : (id ?? "Source");
    const resource = typeof s.resource === "string" ? s.resource : null;
    const internal = s.internal as JsonObject | null;
    let where = "";
    if (internal?.broken) {
      where = `${esc(resource ?? "")} ${chip("missing", "bad")}`;
    } else if (internal && typeof internal.path === "string") {
      const signals = [
        internal.trust_tier ? trustChip(String(internal.trust_tier)) : "",
        internal.stale ? chip("stale", "bad") : "",
        internal.status && internal.status !== "stable"
          ? chip(String(internal.status), "warn")
          : "",
      ].join("");
      where = `<a href="${esc(urls.file(internal.path))}">${esc(resource ?? internal.path)}</a> ${signals}`;
    } else if (resource) where = scalar(resource);
    const def = id ? footnotes.get(id) : undefined;
    if (id) used.add(id);
    const cited = typeof s.cited === "number" ? s.cited : 0;
    return `<li${id ? ` id="${esc(anchorId("src", id))}"` : ""}><strong>${esc(name)}</strong>
${id ? `<div class="small muted">[^${esc(id)}] · cited ${cited}×</div>` : ""}
<div class="small">${where}</div>${def ? `<div class="small muted">${def}</div>` : ""}</li>`;
  });
  const others = [...footnotes].filter(([label]) => !used.has(label));
  const otherItems = others.map(
    ([label, html]) =>
      `<li id="${esc(anchorId("fn", label))}"><span class="small muted">[^${esc(label)}]</span> <span class="small">${html}</span></li>`,
  );
  const unmatched = data.unmatched_footnotes.length
    ? `<p class="small warn">No source for ${data.unmatched_footnotes.map((l) => `[^${esc(l)}]`).join(", ")}</p>`
    : "";
  if (items.length === 0 && otherItems.length === 0 && !unmatched) return "";
  return `<section id="sources"><h2>Sources</h2>${items.length ? `<ul>${items.join("")}</ul>` : ""}
${otherItems.length ? `<p class="small muted">Other footnotes</p><ul>${otherItems.join("")}</ul>` : ""}${unmatched}</section>`;
}

function linksPanel(urls: Urls, data: LinksData, head: number): string {
  const atHead = urls.at === undefined || urls.at >= head;
  const inbound = data.inbound.length
    ? `<ul>${data.inbound
        .map(
          (l) =>
            `<li><a href="${esc(urls.pinned(undefined).file(l.path))}">${esc(l.path)}</a>${l.kind === "source" ? ' <span class="small muted">cites it</span>' : ""}</li>`,
        )
        .join("")}</ul>`
    : `<p class="small muted">${atHead ? "Nothing links here." : "Inbound links are shown for the current version."}</p>`;
  const broken = data.broken.length
    ? `<p class="small warn">Broken: ${data.broken.map((b) => `<code>${esc(b.raw)}</code>`).join(", ")}</p>`
    : "";
  return `<section><h2>Linked from</h2>${inbound}${broken}</section>`;
}

/** Ops that change a file's content (or remove it), and so have a diff. */
const CONTENT_OPS = new Set(["put", "import", "revert", "delete", "attach"]);

function historyPanel(urls: Urls, c: ConceptData, head: number, events: HistoryEvent[]): string {
  const shown = [...events].reverse().slice(0, 50);
  const items = shown
    .map((e) => {
      const note = typeof e.meta?.note === "string" ? ` · ${esc(e.meta.note)}` : "";
      const from = typeof e.meta?.from_path === "string" ? ` from ${esc(e.meta.from_path)}` : "";
      const head = `<strong>${e.seq}</strong> ${esc(e.op)}`;
      const seqLink =
        e.op === "delete" ? head : `<a href="${esc(urls.pinned(e.seq).file(e.path))}">${head}</a>`;
      const diff = CONTENT_OPS.has(e.op)
        ? ` · <a href="${esc(urls.diff(e.path, undefined, e.seq))}">diff</a>`
        : "";
      const cls = e.seq === c.seq ? ' class="current"' : "";
      return `<li${cls}>${seqLink}${from} · ${esc(e.actor)} · ${esc(when(e.ts))}${note}${diff}</li>`;
    })
    .join("");
  const more =
    events.length > shown.length
      ? `<p class="small muted">${events.length - shown.length} older events not shown.</p>`
      : "";
  const picker = `<form class="inline" method="get" action="${esc(urls.pinned(undefined).file(c.path))}">
<label class="small" for="at">View at sequence</label>
<input id="at" name="at" type="number" min="1" max="${head}" value="${urls.at ?? head}">
<button type="submit">View</button></form>`;

  // Time travel shortcuts (spec: Time travel in the UI).
  const verified = [...events]
    .reverse()
    .find((e) => e.op === "verify" && e.actor.startsWith("human:"));
  let sinceHuman: string;
  if (!verified) sinceHuman = "Never verified by a human.";
  else if (events.some((e) => e.seq > verified.seq && CONTENT_OPS.has(e.op))) {
    sinceHuman = `<a href="${esc(urls.diff(c.path, verified.seq))}">Changes since human verification</a> (seq ${verified.seq}, ${esc(verified.actor)})`;
  } else sinceHuman = `No changes since ${esc(verified.actor)} verified it at seq ${verified.seq}.`;
  const pinnedOld = urls.at !== undefined && urls.at < head;
  const restore = pinnedOld
    ? ` · <a href="${esc(urls.restore(c.path, urls.at as number))}">Restore this version…</a>`
    : "";
  return `<section><h2>History</h2>${picker}<p class="small">${sinceHuman}</p><ol class="history">${items}</ol>${more}
<p class="small"><a href="${esc(urls.raw(c.path))}">Raw source</a>${pinnedOld ? ` · <a href="${esc(urls.pinned(undefined).file(c.path))}">Current version</a>` : ""}${restore}</p></section>`;
}

// ---------------------------------------------------------------- attachment and derived files

export function attachmentPage(opts: {
  urls: Urls;
  head: number;
  path: string;
  size: number;
  media: string | null;
  hash: string;
}): string {
  const { urls } = opts;
  const preview =
    opts.media?.startsWith("image/") === true
      ? `<p><img src="${esc(urls.download(opts.path))}" alt="${esc(baseName(opts.path))}" style="max-width:100%"></p>`
      : "";
  return `${crumbs(urls, opts.path, true)}
<h1>${esc(baseName(opts.path))}</h1>
${atNotice(urls, opts.head, urls.pinned(undefined).file(opts.path))}
<p class="muted">${esc(opts.media ?? "file")} · ${formatSize(opts.size)} · <code>${esc(opts.hash.slice(0, 12))}</code></p>
<p><a href="${esc(urls.download(opts.path))}">Download</a></p>${preview}`;
}

export function derivedPage(opts: {
  urls: Urls;
  head: number;
  path: string;
  markdown: string;
  url(target: string, kind: "link" | "image"): string | null;
}): string {
  const { urls } = opts;
  const rendered = renderBody(opts.markdown, { url: opts.url, footnote: () => null });
  return `${crumbs(urls, opts.path, true)}
${atNotice(urls, opts.head, urls.pinned(undefined).file(opts.path))}
<p class="small muted">Synthesized by the server. <a href="${esc(urls.raw(opts.path))}">Raw</a></p>
<article class="body">${rendered.html}</article>`;
}

export { dirOf };

// ---------------------------------------------------------------- diffs

/** A unified diff as HTML, one line per row, colored by kind. */
export function diffHtml(diff: string): string {
  if (diff.trim() === "") return `<p class="muted">No differences.</p>`;
  const lines = diff.replace(/\n$/, "").split("\n");
  const rows = lines.map((line) => {
    let cls = "ctx";
    if (line.startsWith("+++") || line.startsWith("---")) cls = "meta";
    else if (line.startsWith("@@")) cls = "hunk";
    else if (line.startsWith("+")) cls = "add";
    else if (line.startsWith("-")) cls = "del";
    else if (line.startsWith("\\")) cls = "meta";
    return `<span class="${cls}">${esc(line) || " "}</span>`;
  });
  return `<pre class="diff">${rows.join("")}</pre>`;
}

export function diffPage(opts: {
  urls: Urls;
  head: number;
  path: string;
  from: number;
  to: number;
  diff: string;
}): string {
  const { urls, path, from, to } = opts;
  const at = (seq: number) =>
    `<a href="${esc(urls.pinned(seq >= opts.head ? undefined : seq).file(path))}">seq ${seq}</a>`;
  const form = `<form class="inline" method="get" action="${esc(urls.diff(path))}">
<label class="small" for="from">From</label><input id="from" name="from" type="number" min="0" max="${opts.head}" value="${from}">
<label class="small" for="to">to</label><input id="to" name="to" type="number" min="0" max="${opts.head}" value="${to}">
<button type="submit">Compare</button></form>`;
  return `${crumbs(urls, path, true)}
<h1>Changes to ${esc(baseName(path))}</h1>
<p class="muted">From ${at(from)} to ${at(to)}, as rendered markdown.</p>
${form}
${diffHtml(opts.diff)}`;
}

// ---------------------------------------------------------------- ledger

export interface LedgerEvent {
  seq: number;
  op: string;
  path: string;
  meta: JsonObject | null;
}

export interface LedgerRequest {
  request_id: string;
  ts: string;
  actor: string;
  note: string | null;
  events: LedgerEvent[];
}

function eventLine(urls: Urls, e: LedgerEvent): string {
  const from =
    typeof e.meta?.from_path === "string"
      ? ` <span class="muted">from ${esc(e.meta.from_path)}</span>`
      : "";
  // A deleted file is shown as it was just before.
  const view = urls.pinned(e.op === "delete" ? e.seq - 1 : e.seq).file(e.path);
  const diff = CONTENT_OPS.has(e.op)
    ? ` · <a class="small" href="${esc(urls.diff(e.path, undefined, e.seq))}">diff</a>`
    : "";
  return `<li><span class="op op-${esc(e.op)}">${esc(e.op)}</span> <a href="${esc(view)}">${esc(e.path)}</a>${from}${diff}</li>`;
}

export function ledgerPage(opts: {
  urls: Urls;
  filters: LedgerFilters;
  requests: LedgerRequest[];
  next: number | null;
  notice?: string;
}): string {
  const { urls, filters: f } = opts;
  const form = `<form class="filters" method="get" action="${esc(urls.ledger())}">
<label>Directory <input type="text" name="prefix" value="${esc(f.prefix ?? "")}" placeholder="all"></label>
<label>Actor <input type="text" name="actor" value="${esc(f.actor ?? "")}" placeholder="anyone"></label>
<label>From <input type="date" name="from" value="${esc(f.from ?? "")}"></label>
<label>To <input type="date" name="to" value="${esc(f.to ?? "")}"></label>
<button type="submit">Filter</button> <a class="small" href="${esc(urls.ledger())}">Clear</a></form>`;
  const items = opts.requests
    .map((r) => {
      const shown = r.events.slice(0, 12);
      const more = r.events.length - shown.length;
      const revertible = r.events.some((e) => e.op !== "verify");
      const actorLink = `<a href="${esc(urls.ledger({ ...f, actor: r.actor, before: undefined }))}">${esc(r.actor)}</a>`;
      return `<li class="request"><div class="req-head"><span class="muted small">${esc(when(r.ts))}</span> ${actorLink}
<span class="muted small">seq ${r.events[0]?.seq}${r.events.length > 1 ? `–${r.events.at(-1)?.seq}` : ""}</span>
${revertible ? `<a class="small revert" href="${esc(urls.revert(r.request_id))}">Revert…</a>` : ""}</div>
${r.note ? `<div class="note">${esc(r.note)}</div>` : ""}
<ul class="events">${shown.map((e) => eventLine(urls, e)).join("")}</ul>
${more > 0 ? `<p class="small muted">… and ${more} more</p>` : ""}</li>`;
    })
    .join("");
  const older = opts.next
    ? `<p><a href="${esc(urls.ledger({ ...f, before: opts.next }))}">Older requests →</a></p>`
    : "";
  return `<h1>Ledger</h1>
<p class="muted">Every change to ${esc(urls.slug)}, newest first, one entry per request.</p>
${opts.notice ? `<div class="notice ok">${esc(opts.notice)}</div>` : ""}
${form}
${items ? `<ol class="ledger">${items}</ol>` : `<p class="muted">No requests match.</p>`}
${older}`;
}

// ---------------------------------------------------------------- revert and restore

export function revertPage(opts: {
  urls: Urls;
  request: LedgerRequest;
  diffs: { path: string; diff: string }[];
  actor: string;
}): string {
  const { urls, request: r } = opts;
  const diffs = opts.diffs.map((d) => `<h2>${esc(d.path)}</h2>${diffHtml(d.diff)}`).join("");
  return `<h1>Revert this request?</h1>
<p>${esc(when(r.ts))} by <strong>${esc(r.actor)}</strong>${r.note ? `: ${esc(r.note)}` : ""}</p>
<ul class="events">${r.events.map((e) => eventLine(urls, e)).join("")}</ul>
<div class="panel-box">
<p>Reverting puts every file this request touched back as it was just before it: edits are undone,
created files are removed, deleted files come back and moves go back. It is recorded in the ledger
as a new request by <strong>${esc(opts.actor)}</strong>, so it can itself be reverted.</p>
<form method="post" action="${esc(urls.revert(r.request_id))}">
<label>Note <input type="text" name="note" value="Revert: ${esc(r.note ?? r.request_id)}" style="width:100%"></label>
<p><button class="primary" type="submit">Revert</button> <a href="${esc(urls.ledger())}">Cancel</a></p></form></div>
<p class="small muted">What this request changed:</p>
${diffs}`;
}

export function restorePage(opts: {
  urls: Urls;
  path: string;
  to: number;
  diff: string;
  actor: string;
}): string {
  const { urls, path, to } = opts;
  return `${crumbs(urls, path, true)}
<h1>Restore ${esc(baseName(path))} as of seq ${to}?</h1>
<div class="panel-box">
<p>This writes the version from seq ${to} back as the current version, recorded in the ledger as a
revert by <strong>${esc(opts.actor)}</strong>. Nothing is lost: the current version stays in the history.</p>
<form method="post" action="${esc(urls.restore(path, to))}">
<label>Note <input type="text" name="note" value="Restore ${esc(path)} to seq ${to}" style="width:100%"></label>
<p><button class="primary" type="submit">Restore</button> <a href="${esc(urls.pinned(to).file(path))}">Cancel</a></p></form></div>
<p class="small muted">Current version → version at seq ${to}:</p>
${diffHtml(opts.diff)}`;
}
