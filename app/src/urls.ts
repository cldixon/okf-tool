/** URLs of the app's pages for one library, optionally pinned to a sequence (v2 spec: URLs). */
export class Urls {
  readonly base: string;
  constructor(
    readonly owner: string,
    readonly slug: string,
    readonly at?: number,
  ) {
    this.base = `/${encodeURIComponent(owner)}/${encodeURIComponent(slug)}/`;
  }
  private q() {
    return this.at === undefined ? "" : `?at=${this.at}`;
  }
  pinned(at: number | undefined) {
    return new Urls(this.owner, this.slug, at);
  }
  private page(rest: string) {
    return `${this.base}-/${rest}`;
  }
  /** Directories and files sit at their own path, unless it starts with the pages' `-/`. */
  private own(path: string) {
    return path === "-" || path.startsWith("-/") ? null : `${this.base}${enc(path)}`;
  }
  tree(dir: string) {
    if (dir === "") return `${this.base}${this.q()}`;
    return `${this.own(dir) ?? this.page(`tree/${enc(dir)}`)}/${this.q()}`;
  }
  file(path: string, anchor: string | null = null) {
    return `${this.own(path) ?? this.page(`files/${enc(path)}`)}${this.q()}${anchor ?? ""}`;
  }
  /** A page opened in review mode: the changes since a person verified it, and Verify. */
  review(path: string) {
    return `${this.own(path) ?? this.page(`files/${enc(path)}`)}?review=1`;
  }
  /** A page with the changes since an earlier version drawn in its text. */
  since(path: string, seq: number) {
    return `${this.own(path) ?? this.page(`files/${enc(path)}`)}?since=${seq}`;
  }
  /** A page with one comment thread open in its Comments panel. */
  thread(path: string, id: string) {
    return this.file(path, `#thread-${encodeURIComponent(id)}`);
  }
  raw(path: string) {
    return `${this.base}-/raw/${enc(path)}${this.q()}`;
  }
  download(path: string) {
    return `${this.base}-/download/${enc(path)}${this.q()}`;
  }
  /**
   * What changed in a page, on its own page (take 4, TEMPRA-124): the changes since `from`
   * drawn in its text (`?since=`), or with only `to`, that version as History opens it. The old
   * Diff page's address (`-/diff/…?from=&to=`) is sent here.
   */
  diff(path: string, from?: number, to?: number) {
    if (from !== undefined) return this.since(path, from);
    return this.pinned(to).file(path);
  }
  /**
   * Activity's Every event view at the ledger's own address (take 4, TEMPRA-115): `-/ledger`
   * stays as the audit view's URL and opens that view, with the same filters.
   */
  ledger(filters: Omit<ActivityFilters, "view"> = {}) {
    return `${this.base}-/ledger${activityQuery(filters)}`;
  }
  /** The ledger as JSON lines, every event in order (a server download). */
  ledgerJsonl() {
    return this.page("ledger.jsonl");
  }
  revert(requestId: string) {
    return `${this.base}-/revert/${encodeURIComponent(requestId)}`;
  }
  restore(path: string, to: number) {
    return `${this.base}-/restore/${enc(path)}${query({ to })}`;
  }
  /**
   * Activity (take 4, TEMPRA-115): the Summary (requests grouped by day) or Every event (the
   * ledger as a table), filtered as the page's controls set.
   */
  activity(filters: ActivityFilters = {}) {
    const view = filters.view === "events" ? "events" : undefined;
    return `${this.page("activity")}${activityQuery(filters, view)}`;
  }
  /**
   * The export download (a server redirect to a signed link): the files as they are, or with
   * `okf` an OKF bundle (with index.md and log.md) for tools that read that format.
   */
  exportTar(at?: number, format?: "okf") {
    return `${this.page("export")}${query({ format, at })}`;
  }
  /** A nightly export's file (served by the server from R2). */
  nightly(date: string, file: string) {
    return this.page(`exports/${encodeURIComponent(date)}/${encodeURIComponent(file)}`);
  }
  /** The library's settings: one page of sections (General first), each at its own anchor. */
  settings(section?: SettingsSection) {
    return `${this.page("settings")}${section ? `#${section}` : ""}`;
  }
  transfer() {
    return this.settings("transfer");
  }
  recovery() {
    return this.settings("recovery");
  }
  connect() {
    return this.settings("connect");
  }
  remove() {
    return this.settings("delete");
  }
  members() {
    return this.settings("members");
  }
  /** The REST API for this library. */
  api(rest: string, params: Record<string, string | number | undefined> = {}) {
    return `${this.apiRoot()}/${rest}${query(params)}`;
  }
  /** The library itself in the REST API (its title and description, TEMPRA-102). */
  apiRoot() {
    return `/api/v1/libraries/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.slug)}`;
  }
}

/** The library's Settings page's sections, by their anchors (tempra-dev: app/workspace). */
export type SettingsSection =
  | "general"
  | "members"
  | "connect"
  | "transfer"
  | "recovery"
  | "delete";

/** Activity's views: the Summary (the default) and Every event (the ledger as a table). */
export type ActivityView = "summary" | "events";

/** Whose requests a view shows: anyone, agents only, people only. */
export type Who = "everyone" | "agents" | "people";

/**
 * Activity's filters, in the URL so a view can be linked. Both views: who, and the server's
 * folder `prefix` (reachable by URL, no control). Every event also: one exact `actor`, an event
 * `kind` and a text filter `q` on path or note.
 */
export interface ActivityFilters {
  view?: ActivityView;
  who?: Who;
  prefix?: string;
  actor?: string;
  kind?: string;
  q?: string;
}

function activityQuery(f: ActivityFilters, view?: string) {
  return query({
    view,
    who: f.who === "everyone" ? undefined : f.who,
    prefix: f.prefix,
    actor: f.actor,
    kind: f.kind,
    q: f.q,
  });
}

export const enc = (p: string) => p.split("/").map(encodeURIComponent).join("/");

export function query(params: Record<string, string | number | undefined>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== "") q.set(k, String(v));
  }
  const s = q.toString();
  return s ? `?${s}` : "";
}

export function baseName(path: string) {
  return path.slice(path.lastIndexOf("/") + 1);
}

export function dirOf(path: string) {
  const i = path.lastIndexOf("/");
  return i === -1 ? "" : path.slice(0, i);
}

/**
 * A folder as a person reads it, until folders have titles of their own: its name with the first
 * letter capitalised and dashes and underscores as spaces ("the-app" → "The app").
 */
export function folderName(path: string) {
  const name = baseName(path).replace(/[-_]+/g, " ").trim();
  return name ? name[0]?.toUpperCase() + name.slice(1) : path;
}

/** A library's Urls from its "owner/slug" (as notifications and the API name it). */
export function urlsOf(library: string): Urls {
  const [owner = "", slug = ""] = library.split("/");
  return new Urls(owner, slug);
}

/**
 * One Urls per library and pinned sequence, so pages and what they derive see the same object
 * across navigations (a fragment change must not remount the reader).
 */
const urlsCache = new Map<string, Urls>();
export function urlsFor(owner: string, slug: string, at: number | undefined): Urls {
  const key = `${owner}/${slug}@${at ?? ""}`;
  let urls = urlsCache.get(key);
  if (!urls) {
    urls = new Urls(owner, slug, at);
    urlsCache.set(key, urls);
  }
  return urls;
}
