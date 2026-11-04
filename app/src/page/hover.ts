import type { RootContent } from "mdast";
import { api } from "../api";
import type { Prepared } from "../reader/prepare";
import type { Hovered } from "../reader/reading";
import { baseName, enc, type Urls } from "../urls";
import type { FileJson, JsonObject, Sources } from "./data";

/**
 * Cards over the body: a footnote marker shows the source it cites (or its note), an internal
 * link the target's title, type and staleness (no trust tiers: those are for agents), an
 * external link its URL. The reader asks `hover` what a card shows; `HoverCard.svelte` draws it.
 */
export type Card =
  /** A footnote that cites no source: its note, drawn as the body draws it. */
  | { kind: "note"; prepared: Prepared; nodes: readonly RootContent[] }
  /** A footnote citing a source: its title, resource, and whether it is missing or stale. */
  | { kind: "source"; title: string; resource: string | null; broken: boolean; stale: boolean }
  /** A line of text: an external link's URL, a missing target, a file. */
  | { kind: "text"; text: string }
  /** A page in the library: its title, type and staleness, and description. */
  | { kind: "page"; title: string; facts: string; description: string | null };

/** What a card shows for what the pointer or focus is on (a promise for a page it loads). */
export function hoverCards(
  urls: Urls,
  sources: Sources,
  prepared: Prepared,
  targets: Map<string, Promise<FileJson | null>> = new Map(),
) {
  return (h: Hovered): Card | Promise<Card | null> | null => {
    if (h.kind === "footnote") {
      const s = sources.sources.find((x) => x.id === h.label);
      if (!s) {
        const note = prepared.footnotes.find((f) => f.label === h.label);
        if (!note) return null;
        return { kind: "note", prepared, nodes: note.node.children };
      }
      const internal = (s.internal ?? null) as JsonObject | null;
      return {
        kind: "source",
        title: typeof s.title === "string" ? s.title : h.label,
        resource: typeof s.resource === "string" ? s.resource : null,
        broken: !!internal?.broken,
        stale: !!internal?.stale,
      };
    }
    if (h.path === null) return h.href ? { kind: "text", text: h.href } : null;
    if (h.broken) return { kind: "text", text: "Missing: no page is at this link" };
    const path = h.path;
    let target = targets.get(path);
    if (!target) {
      target = api<FileJson>(urls.api(`files/${enc(path)}`)).catch(() => null);
      targets.set(path, target);
    }
    return target.then((t): Card => {
      if (!t) return { kind: "text", text: baseName(path) };
      if (t.kind !== "concept") return { kind: "text", text: `${baseName(t.path)} · file` };
      const tfm = t.frontmatter;
      const facts = [typeof tfm.type === "string" ? tfm.type : "", t.stale ? "Stale" : ""];
      return {
        kind: "page",
        title: typeof tfm.title === "string" ? tfm.title : baseName(t.path),
        facts: facts.filter(Boolean).join(" · "),
        description: typeof tfm.description === "string" ? tfm.description : null,
      };
    });
  };
}
