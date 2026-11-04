import { docText, wordDiff } from "@tempra/editor";
import { ApiError, api } from "../api";
import { useLoad } from "../load.svelte.ts";
import type { Prepared } from "../reader/prepare";
import { enc, type Urls } from "../urls";
import type { FileJson } from "./data";

/**
 * The body on screen against an earlier version of it, as a word diff drawn in place (tempra-dev:
 * app/reader, Review and History): what changed since a person verified it, or since a version
 * chosen from the history menu. `seq` null compares nothing.
 */
export function useCompare(
  urls: () => Urls,
  path: () => string,
  prepared: () => Prepared,
  seq: () => number | null,
) {
  const old = useLoad(
    () => {
      const s = seq();
      return s === null ? "version none" : `version ${urls().file(path())}@${s}`;
    },
    async () => {
      const s = seq();
      if (s === null) return null;
      const f = await api<FileJson>(urls().api(`files/${enc(path())}`, { at: s }));
      if (f.kind !== "concept") {
        throw new ApiError(400, "not_concept", "That version is not a page.");
      }
      return f.doc;
    },
  );
  const doc = $derived(old.data ?? null);
  const diff = $derived(doc ? wordDiff(docText(doc), prepared().text) : null);
  return {
    get diff() {
      return seq() === null ? null : diff;
    },
    get error() {
      return seq() !== null && old.state === "error" ? (old.error?.message ?? null) : null;
    },
  };
}
