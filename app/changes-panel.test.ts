/**
 * The changes panel (TEMPRA-291, a spike; tempra-dev app/source-diff): what it takes from a `diff`
 * result, the patch as Pierre's file (named for the page, plain text), its counts, and its head
 * and layout toggle drawn with a fake host.
 */
import { describe, expect, test } from "bun:test";
import type { ChangesPayload } from "./src/panels/changes";

// Pierre defines its custom element when it loads, with a constructed stylesheet; the test
// window's registry and CSSStyleSheet are not globals.
const g = globalThis as {
  customElements?: CustomElementRegistry;
  CSSStyleSheet?: typeof CSSStyleSheet;
  window?: Window & { CSSStyleSheet?: typeof CSSStyleSheet };
};
g.customElements ??= g.window?.customElements;
g.CSSStyleSheet ??= g.window?.CSSStyleSheet;
const { changesFrom, counts, fileOf, mountChangesPanel } = await import("./src/panels/changes");

const PATCH = `--- notes/a.md@3
+++ notes/a.md@7
@@ -1,3 +1,4 @@
 # A
-Alpha beta.
+Alpha delta.
+Gamma.
 End.
`;

function payload(over: Partial<ChangesPayload> = {}): ChangesPayload {
  return {
    v: 1,
    library: { owner: "ann", slug: "notes" },
    path: "notes/a.md",
    from: 3,
    to: 7,
    patch: PATCH,
    ...over,
  };
}

describe("the changes panel", () => {
  test("takes `structuredContent.changes`, and nothing else", () => {
    expect(changesFrom({ structuredContent: { changes: payload() } })).toEqual(payload());
    expect(changesFrom({ structuredContent: { page: {} } })).toBeNull();
    expect(changesFrom({ structuredContent: { changes: { ...payload(), v: 2 } } })).toBeNull();
    expect(changesFrom({ structuredContent: { changes: { ...payload(), from: "3" } } })).toBeNull();
    expect(changesFrom(null)).toBeNull();
  });

  test("the patch is one file named for the page, drawn as plain text", () => {
    const file = fileOf(payload());
    expect(file?.name).toBe("notes/a.md");
    expect(file?.lang).toBe("text");
    expect(file?.hunks.length).toBe(1);
    expect(fileOf(payload({ patch: "" }))).toBeNull();
  });

  test("counts added and removed lines, not the header", () => {
    expect(counts(payload())).toEqual({ added: 2, removed: 1 });
  });

  test("draws the head and a stacked diff, and splits it on request", () => {
    const root = document.createElement("main");
    document.body.append(root);
    const panel = mountChangesPanel(root, { scheme: () => "light" });
    panel.show(payload());
    expect(root.querySelector(".cp-title")?.textContent).toBe("notes/a.md");
    expect(root.querySelector(".cp-meta")?.textContent).toBe(
      "Changes from seq 3 to 7 · 2 added, 1 removed",
    );
    const [stacked, split] = Array.from(root.querySelectorAll(".cp-layout button"));
    expect(stacked?.getAttribute("aria-pressed")).toBe("true");
    expect(root.querySelector(".cp-diff diffs-container")).not.toBeNull();
    (split as HTMLButtonElement).click();
    const [, splitNow] = Array.from(root.querySelectorAll(".cp-layout button"));
    expect(splitNow?.getAttribute("aria-pressed")).toBe("true");
    expect(root.querySelectorAll(".cp-diff diffs-container").length).toBe(1);

    panel.show(payload({ patch: "" }));
    expect(root.textContent).toContain("No difference.");
    expect(root.querySelector(".cp-layout")).toBeNull();
    panel.show(null);
    expect(root.textContent).toContain("These changes could not be shown.");
    root.remove();
  });
});
