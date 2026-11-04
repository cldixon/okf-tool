import { describe, expect, test } from "bun:test";
import { fileOptions } from "./src/switcher";
import type { OutlineFile } from "./src/tree";
import { Urls } from "./src/urls";

/* The quick switcher's list (switcher.ts): recent files first, then the index's matches. */

const urls = new Urls("ann", "notes");
const file = (path: string, title: string): OutlineFile =>
  ({ path, kind: "page", title, seq: 1 }) as OutlineFile;

describe("fileOptions", () => {
  test("recent files first, then the index's", () => {
    const index = [file("a.md", "Alpha"), file("b.md", "Beta")];
    const keys = fileOptions(urls, "", [{ path: "b.md", title: "Beta" }], index, []).map(
      (o) => o.key,
    );
    expect(keys).toEqual(["b.md"]);
    const typed = fileOptions(urls, "a", [{ path: "b.md", title: "Beta" }], index, []);
    expect(typed.map((o) => o.key)).toEqual(["b.md", "a.md"]);
  });

  test("a recent file no longer in the index is not offered", () => {
    const index = [file("a.md", "Alpha")];
    const recent = [
      { path: "gone.md", title: "Gone" },
      { path: "a.md", title: "Alpha" },
    ];
    expect(fileOptions(urls, "", recent, index, []).map((o) => o.key)).toEqual(["a.md"]);
    // Until the index arrives, recent files stand.
    expect(fileOptions(urls, "", recent, [], []).map((o) => o.key)).toEqual(["gone.md", "a.md"]);
  });
});
