/**
 * Parts of the app fetched on first use (the account's and a library's settings pages, the
 * components' catalogue) are files named by their build (`/_app/settings-<hash>.js`). A tab opened
 * before a deploy asks for the names its own build gave them, which the new build no longer
 * serves (a plain 404), so the import fails, and a failed import stays failed in the page's module
 * map. Then the page loads afresh, once: the server answers with the current shell and bundle,
 * at the same address. A second failure within a minute is not retried (the caller shows it), so
 * a chunk that is really missing never reloads in a loop.
 */

/** Where the time of the last reload for a new build is kept, for this tab. */
export const RELOAD_KEY = "tempra-reloaded-for-build";

/** How long after one reload another is not tried. */
export const RELOAD_GAP_MS = 60_000;

export interface ReloadEnv {
  now(): number;
  /** Reads and writes this tab's session storage; may throw (a private window, blocked storage). */
  get(key: string): string | null;
  set(key: string, value: string): void;
  reload(): void;
}

/** Whether the page was sent to load afresh (true), or a reload was tried too recently (false). */
export function reloadForNewBuild(env: ReloadEnv): boolean {
  let last = 0;
  try {
    last = Number(env.get(RELOAD_KEY) ?? 0) || 0;
  } catch {
    // No storage: reload all the same; without a record, the next failure reloads again, which is
    // what a tab with no storage would do by hand.
  }
  const now = env.now();
  if (now - last < RELOAD_GAP_MS) return false;
  try {
    env.set(RELOAD_KEY, String(now));
  } catch {
    // As above.
  }
  env.reload();
  return true;
}

const browserEnv = (): ReloadEnv => ({
  now: () => Date.now(),
  get: (k) => sessionStorage.getItem(k),
  set: (k, v) => sessionStorage.setItem(k, v),
  reload: () => location.reload(),
});

/**
 * A chunk's loader, fetched once and kept. When it fails, the page reloads for the new build (see
 * above) and the promise stays pending, so nothing flashes before the reload; when a reload was
 * just tried, it rejects, for the page to say so, and the next call tries the chunk again.
 */
export function lazy<T>(
  load: () => Promise<T>,
  env: () => ReloadEnv = browserEnv,
): () => Promise<T> {
  let kept: Promise<T> | null = null;
  return () => {
    kept ??= load().catch((e: unknown) => {
      kept = null;
      if (reloadForNewBuild(env())) return new Promise<T>(() => {});
      throw e;
    });
    return kept;
  };
}
