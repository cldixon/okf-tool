import { isShared, type ReachableLibrary } from "../role";
import { plural, relativeTime } from "../ui";

/** A library as the list shows it (`GET /api/v1/libraries`), with its summary. */
export interface Library extends ReachableLibrary {
  seq?: number;
  pages?: number;
  attachments?: number;
  /** Its newest ledger event, else when it was made (TEMPRA-202); the list is ordered by it. */
  last_activity?: string | null;
  /** Its summary could not be read just now (TEMPRA-23): listed and linked, without counts. */
  unavailable?: boolean;
}

/** A library's address from its name: lowercase letters, digits and dashes, as the server checks. */
export function slugFrom(name: string): string {
  return name
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .slice(0, 63)
    .replace(/-+$/, "");
}

/**
 * A card's line of facts: the person's access when shared, its page count, when it was last
 * active, a failed summary.
 */
export function cardFacts(l: Library): string[] {
  const facts: string[] = [];
  if (isShared(l)) facts.push(l.role === "write" ? "Write" : "Read");
  if (typeof l.pages === "number") facts.push(plural(l.pages, "page"));
  if (l.last_activity) facts.push(`active ${relativeTime(l.last_activity)}`);
  if (l.unavailable) facts.push("couldn't load just now");
  return facts;
}
