/**
 * Bundle paths: slash-separated, no leading slash in storage (spec: Concepts and terminology).
 * Directories are prefixes, not objects.
 */

export const RESERVED_NAMES = new Set(["index.md", "log.md"]);

/** The last segment of a path. */
export function basename(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? path : path.slice(i + 1);
}

/** The directory part of a path, "" at the root. */
export function dirname(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? "" : path.slice(0, i);
}

export function isReserved(path: string): boolean {
  return RESERVED_NAMES.has(basename(path));
}

export function isConceptPath(path: string): boolean {
  return path.endsWith(".md") && !isReserved(path);
}

/**
 * Normalizes a storage path: strips leading slashes, collapses `.` and `..`, and rejects paths
 * that escape the root or are empty. Returns null when the path is invalid.
 */
export function normalizePath(path: string): string | null {
  const out: string[] = [];
  for (const seg of path.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (out.length === 0) return null;
      out.pop();
      continue;
    }
    out.push(seg);
  }
  return out.length === 0 ? null : out.join("/");
}

/** Normalizes a directory prefix: "" for the root, otherwise no leading or trailing slash. */
export function normalizeDir(dir: string | undefined | null): string {
  if (!dir) return "";
  return normalizePath(dir) ?? "";
}

/** True when `path` is `dir` itself or lies under it ("" contains everything). */
export function underPrefix(path: string, prefix: string): boolean {
  if (prefix === "") return true;
  return path === prefix || path.startsWith(`${prefix}/`);
}

/**
 * Resolves a link target written in the concept at `fromPath`. Absolute targets (leading `/`) are
 * bundle-relative; everything else is relative to the concept's directory.
 */
export function resolveLinkPath(fromPath: string, target: string): string | null {
  if (target.startsWith("/")) return normalizePath(target);
  const dir = dirname(fromPath);
  return normalizePath(dir === "" ? target : `${dir}/${target}`);
}

/** The relative path from the directory of `fromPath` to `toPath`. */
export function relativePath(fromPath: string, toPath: string): string {
  const from = dirname(fromPath).split("/").filter(Boolean);
  const to = toPath.split("/");
  let i = 0;
  while (i < from.length && i < to.length - 1 && from[i] === to[i]) i++;
  const ups = from.length - i;
  return [...Array<string>(ups).fill(".."), ...to.slice(i)].join("/");
}

/** Splits `path#anchor` (and drops any `?query`). */
export function splitAnchor(target: string): { path: string; anchor: string | null } {
  let t = target;
  let anchor: string | null = null;
  const hash = t.indexOf("#");
  if (hash !== -1) {
    anchor = t.slice(hash);
    t = t.slice(0, hash);
  }
  const q = t.indexOf("?");
  if (q !== -1) t = t.slice(0, q);
  return { path: t, anchor };
}

/** True for link targets that point outside the bundle (a URL scheme, `//host`, or `mailto:`). */
export function isExternal(target: string): boolean {
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(target) || target.startsWith("//");
}

export function safeDecode(s: string): string {
  try {
    return decodeURI(s);
  } catch {
    return s;
  }
}
