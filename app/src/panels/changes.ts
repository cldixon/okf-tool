/**
 * The changes panel (TEMPRA-291, a spike; tempra-dev app/source-diff): an MCP App a host draws in
 * the chat beside a `diff` call, the page's Markdown source between two versions as a diff,
 * stacked by default, split on request. Pierre's `@pierre/diffs` draws it into a shadow root,
 * as plain text (no Shiki), themed from the panel's variables (panel.css, `.changes-panel`).
 * Everything comes in the tool's result (`structuredContent.changes`). This module is the panel
 * itself, over a small `ChangesHost`, so it can be drawn without a host.
 */
import {
  FileDiff,
  type FileDiffMetadata,
  parsePatchFiles,
  registerCustomCSSVariableTheme,
} from "@pierre/diffs";
import { markSvg } from "@tempra/design/mark";

/** What `diff` puts in `structuredContent.changes`. */
export interface ChangesPayload {
  v: 1;
  library: { owner: string; slug: string };
  /** The page's path now (or as it was, when it is gone). */
  path: string;
  /** The ledger seqs compared: the older side and the newer one. */
  from: number;
  to: number;
  /** The unified diff of the stored Markdown (`---`/`+++` labels and hunks); "" when equal. */
  patch: string;
}

/** The `structuredContent.changes` of a tool result, when it is one. */
export function changesFrom(
  result: { structuredContent?: unknown } | null | undefined,
): ChangesPayload | null {
  const c = (result?.structuredContent as { changes?: Partial<ChangesPayload> } | undefined)
    ?.changes;
  if (
    c?.v !== 1 ||
    typeof c.path !== "string" ||
    typeof c.patch !== "string" ||
    typeof c.from !== "number" ||
    typeof c.to !== "number"
  ) {
    return null;
  }
  return c as ChangesPayload;
}

/** The two layouts: one column (stacked, the default) or the old and new side by side. */
export type Layout = "unified" | "split";

/** What the panel needs from its host (changes-main.ts). */
export interface ChangesHost {
  /** The host's scheme, for Pierre's `light-dark()` (it sets `color-scheme` on its own root). */
  scheme(): "light" | "dark" | "system";
}

/**
 * The patch as Pierre's file metadata, named for the page and forced to plain text: its header
 * lines are `path@seq`, so the name is the path again, and `lang: "text"` keeps Shiki out.
 */
export function fileOf(payload: ChangesPayload): FileDiffMetadata | null {
  if (!payload.patch) return null;
  const file = parsePatchFiles(payload.patch)[0]?.files[0];
  if (!file) return null;
  return { ...file, name: payload.path, prevName: undefined, lang: "text" };
}

/** Added and removed lines, as the head says them. */
export function counts(payload: ChangesPayload): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of payload.patch.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) added++;
    else if (line.startsWith("-")) removed++;
  }
  return { added, removed };
}

/**
 * Pierre's colours as custom properties (its CSS-variables theme), so no theme catalogue loads
 * and the panel's variables set them: the text and surface here, the rest in panel.css.
 */
const THEME = "tempra";
let registered = false;
function registerTheme(): void {
  if (registered) return;
  registered = true;
  registerCustomCSSVariableTheme(THEME, {
    foreground: "var(--panel-text)",
    background: "var(--panel-surface)",
  });
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> = {},
): HTMLElementTagNameMap[K] {
  return Object.assign(document.createElement(tag), props);
}

/** Draws the panel into `root`; `show` takes each result (null for one it cannot draw). */
export function mountChangesPanel(root: HTMLElement, host: ChangesHost) {
  let layout: Layout = "unified";
  let current: ChangesPayload | null = null;
  let diff: FileDiff | null = null;

  const draw = () => {
    diff?.cleanUp();
    diff = null;
    root.replaceChildren();
    root.className = "changes-panel";
    if (!current) {
      root.append(
        el("p", { className: "muted", textContent: "These changes could not be shown." }),
      );
      return;
    }
    const head = el("header", { className: "cp-head" });
    const where = el("p", { className: "cp-where mark-lockup" });
    where.innerHTML = markSvg({ small: true, label: "Tempra" });
    where.append(`${current.library.owner}/${current.library.slug}`);
    const title = el("h1", { className: "cp-title", textContent: current.path });
    const { added, removed } = counts(current);
    const meta = el("p", {
      className: "cp-meta muted",
      textContent: `Changes from seq ${current.from} to ${current.to} · ${added} added, ${removed} removed`,
    });
    head.append(where, title, meta);
    const file = fileOf(current);
    if (!file) {
      root.append(head, el("p", { className: "muted", textContent: "No difference." }));
      return;
    }
    // Stacked or split: a two-button toggle, the pressed one the layout shown.
    const toggle = el("div", { className: "cp-layout" });
    toggle.setAttribute("role", "group");
    toggle.setAttribute("aria-label", "Layout");
    for (const [value, label] of [
      ["unified", "Stacked"],
      ["split", "Split"],
    ] as const) {
      const b = el("button", { type: "button", textContent: label });
      b.setAttribute("aria-pressed", String(layout === value));
      b.addEventListener("click", () => {
        if (layout === value) return;
        layout = value;
        draw();
      });
      toggle.append(b);
    }
    head.append(toggle);
    const container = el("div", { className: "cp-diff" });
    root.append(head, container);
    registerTheme();
    diff = new FileDiff({
      theme: THEME,
      diffStyle: layout,
      diffIndicators: "classic",
      lineDiffType: "word",
      overflow: "wrap",
      hunkSeparators: "line-info-basic",
      disableFileHeader: true,
      themeType: host.scheme(),
    });
    diff.render({ fileDiff: file, containerWrapper: container });
  };

  return {
    show(payload: ChangesPayload | null) {
      current = payload;
      draw();
    },
    /** Redraws for a new scheme from the host. */
    redraw() {
      if (current) draw();
    },
  };
}
