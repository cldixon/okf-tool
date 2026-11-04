/**
 * The first page's data in the SPA shell (TEMPRA-175; tempra-dev: app/overview). On a cold load
 * the app's first paint waited on HTML, then the bundle, then a dozen API calls, then a render.
 * The Worker has signed the person in and authorized the library for that same URL already, so
 * it makes those GET calls itself, through the same app with the same cookie (the same routes,
 * checks, limits and metering as if the browser had asked), and puts the answers in the shell as
 * a JSON data block. The app's `api()` answers its first call to each of those URLs from it
 * (app/src/boot.ts) instead of the network, once.
 *
 * A JSON block is not executed, so the shell's `script-src 'self'` still holds. Nothing goes in
 * that this session's own API calls would not return, and only the URLs this page asks for first.
 */

/**
 * A URL's key in the boot data: its path and its query sorted by name, so the app finds an
 * answer however its query was built. The app normalizes the same way (app/src/boot.ts).
 */
export function bootKey(url: string): string {
  const u = new URL(url, "http://x");
  const params = [...u.searchParams].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const q = new URLSearchParams(params).toString();
  return q ? `${u.pathname}?${q}` : u.pathname;
}

/** Which page a shell is for: an account page, a library's page, or one of its files. */
export type BootPage =
  | { kind: "account" }
  | { kind: "library"; owner: string; slug: string }
  | { kind: "file"; owner: string; slug: string; path: string; at?: number };

const enc = (path: string) => path.split("/").map(encodeURIComponent).join("/");

/** Whether a path can be a page: markdown, and not a synthesized index.md or log.md. */
const isPagePath = (path: string) => path.endsWith(".md") && !/(^|\/)(index|log)\.md$/.test(path);

/**
 * The API calls the app makes first on a page, as it builds them: the frame's (who the person
 * is, their libraries, the bell's count), a library's (the tree, its agents), and a
 * file's page (app/src/page/data.ts `loadFile`, `GET …/page/{path}`, and the Comments
 * panel's threads). Most
 * important first, since the size budget keeps what fits in order.
 */
export function bootUrls(page: BootPage): string[] {
  // The frame's libraries by name alone, as `useLibraries` asks (app/src/role.ts
  // LIBRARY_NAMES_URL): the shell waits on these calls, and the summaries would make it wait on
  // the slowest cold library the person has (TEMPRA-190).
  const frame = ["/api/v1/me", "/api/v1/libraries?summary=false", "/api/v1/inbox/count"];
  if (page.kind === "account") return frame;
  const lib = `/api/v1/libraries/${encodeURIComponent(page.owner)}/${encodeURIComponent(page.slug)}`;
  const library = [`${lib}/outline`, `${lib}/agents`];
  if (page.kind === "library") return [...frame, ...library];
  const p = enc(page.path);
  const at = page.at === undefined ? "" : `?at=${page.at}`;
  // The file's page in one call (TEMPRA-191), then a page's comment threads.
  const file = [`${lib}/page/${p}${at}`];
  if (isPagePath(page.path)) {
    if (page.at === undefined) {
      file.push(
        `${lib}/comments?${new URLSearchParams({ path: page.path, status: "all", limit: "200" })}`,
      );
    }
  }
  return [...file, ...frame, ...library];
}

/** The most boot data one shell carries; what does not fit is left for the app to fetch. */
export const BOOT_BUDGET = 512 * 1024;

/**
 * How long the shell waits for the calls: one that has not answered by then is left for the app,
 * so a slow call never holds the page back more than this.
 */
export const BOOT_WAIT_MS = 1500;

/**
 * Makes the calls at once with `get` (an in-process GET as the person) and keeps the answers that
 * came back 200 with JSON within the wait, in order, while they fit in the budget. A call that
 * fails or is late is left out: the app asks for it itself and sees what it always would.
 */
export async function bootData(
  urls: string[],
  get: (url: string) => Promise<Response>,
  opts: { budget?: number; waitMs?: number } = {},
): Promise<Record<string, unknown>> {
  const budget = opts.budget ?? BOOT_BUDGET;
  let timeUp: (v: null) => void = () => {};
  const late = new Promise<null>((resolve) => {
    timeUp = resolve;
  });
  const timer = setTimeout(() => timeUp(null), opts.waitMs ?? BOOT_WAIT_MS);
  const answer = async (url: string) => {
    try {
      const r = await get(url);
      if (r.status !== 200 || !r.headers.get("Content-Type")?.includes("application/json")) {
        return null;
      }
      return { url, text: await r.text() };
    } catch {
      return null;
    }
  };
  const answers = await Promise.all(urls.map((url) => Promise.race([answer(url), late])));
  clearTimeout(timer);
  const out: Record<string, unknown> = {};
  let size = 0;
  for (const a of answers) {
    if (!a || size + a.text.length > budget) continue;
    try {
      out[bootKey(a.url)] = JSON.parse(a.text);
      size += a.text.length;
    } catch {}
  }
  return out;
}

/**
 * The data block for the shell. JSON with `<`, `>`, `&` and the line and paragraph separators
 * escaped, so nothing in the data can end the block or start markup.
 */
export function bootScript(data: Record<string, unknown>): string {
  if (Object.keys(data).length === 0) return "";
  const json = JSON.stringify(data).replace(
    /[<>&\u2028\u2029]/g,
    (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
  return `<script type="application/json" id="tempra-boot">${json}</script>`;
}
