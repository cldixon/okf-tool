import { baseName } from "./urls";

/** The person the app acts for (GET /api/v1/me). */
export interface Me {
  email: string;
  handle: string;
  /** The account's name, when the person gave one (TEMPRA-54): the avatar's initials. */
  name?: string | null;
  actor: string;
  /** The account's theme (take 4): light, dark, or null for the system's. */
  theme?: "light" | "dark" | null;
}

/** An actor as a person reads it: a handle for a person (`human:cl_dixon` → `cl_dixon`), an agent as is. */
export const who = (actor: string) => actor.replace(/^human:/, "");

/** The local calendar day of a moment, as a number to compare (days since the epoch, local). */
const localDay = (d: Date) =>
  Math.round(new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() / 86_400_000);

/**
 * When something happened, the one way the app says it (TEMPRA-131, X-4): "just now", "3 min
 * ago", "2 hours ago" today, "yesterday", then the day ("Oct 12", with the year when it is not
 * this one). In the reader's time zone; never seconds, never UTC. `Moment` draws it with the
 * local date and time on hover.
 */
export function relativeTime(ts: string, now: number = Date.now()): string {
  const t = Date.parse(ts);
  if (Number.isNaN(t)) return ts;
  const secs = Math.max(0, Math.round((now - t) / 1000));
  if (secs < 60) return "just now";
  if (secs < 3600) return `${Math.floor(secs / 60)} min ago`;
  const then = new Date(t);
  const today = localDay(new Date(now));
  const d = localDay(then);
  if (d === today) return `${plural(Math.floor(secs / 3600), "hour")} ago`;
  if (d === today - 1) return "yesterday";
  return day(ts);
}

/** One formatter for every local time drawn (making one per call is slow). */
const LOCAL_TIME = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

/** A moment in the reader's own time zone, as people write it: "Oct 21, 2026, 4:52 PM". */
export function localTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return LOCAL_TIME.format(d);
}

/**
 * A day as people say it: "Oct 9", with the year when it is not this one; in the reader's time
 * zone, or in `timeZone`.
 */
export function day(iso: string, timeZone?: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const year = (x: Date) => (timeZone === "UTC" ? x.getUTCFullYear() : x.getFullYear());
  const thisYear = year(d) === year(new Date());
  return d.toLocaleDateString("en", {
    month: "short",
    day: "numeric",
    ...(timeZone ? { timeZone } : {}),
    ...(thisYear ? {} : { year: "numeric" }),
  });
}

/** The first words of a text on one line, ending in "…" when cut at `max` characters. */
export function clip(text: string, max: number): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length <= max ? line : `${line.slice(0, max - 1).replace(/\s+\S*$/, "")}…`;
}

/** Bytes in a few characters: "316 KB", "2.1 MB". */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${Math.round(kb)} KB`;
  const mb = kb / 1024;
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
}

/** The quick switcher's shortcut as this platform writes it (⌘K on Apple devices). */
export const switcherKey = () =>
  typeof navigator !== "undefined" &&
  /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent)
    ? "⌘K"
    : "Ctrl K";

/** The reader's comment shortcut as the person's keyboard names it (Ctrl Alt M, ⌥⌘M). */
export const commentKey = () =>
  typeof navigator !== "undefined" &&
  /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent)
    ? "⌥⌘M"
    : "Ctrl Alt M";

/** A library's letter for its tile: the first of its name, upper case. */
export const tileLetter = (name: string) => (name.trim()[0] ?? "?").toUpperCase();

export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** An element id for a footnote label or source id (as the server's anchorId). */
export const anchorId = (prefix: string, label: string) =>
  `${prefix}-${label.replace(/[^\w.-]/g, "_")}`;

export { baseName };

/**
 * Writes text to the clipboard from a click. Where the browser takes a promise (a
 * ClipboardItem), the text is fetched inside the click's permission; else it is fetched first.
 */
export async function copyText(text: () => Promise<string>): Promise<void> {
  const C = (globalThis as { ClipboardItem?: typeof ClipboardItem }).ClipboardItem;
  if (C && navigator.clipboard?.write) {
    try {
      const blob = text().then((t) => new Blob([t], { type: "text/plain" }));
      await navigator.clipboard.write([new C({ "text/plain": blob })]);
      return;
    } catch {
      // Fall through to writeText.
    }
  }
  await navigator.clipboard.writeText(await text());
}
