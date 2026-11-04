import { useAction } from "../load.svelte.ts";
import type { Urls } from "../urls";
import { markChecked } from "./checked";

/**
 * Mark as checked, wherever the page offers it (the review bar's form, Properties, the page's
 * actions): `check` marks the latest version, with an optional note, then `onVerified`; `busy`
 * meanwhile, and `error` when it failed.
 */
export function useCheck(urls: () => Urls, path: () => string, onVerified: () => void) {
  const action = useAction();
  return {
    get busy() {
      return action.busy;
    },
    get error() {
      return action.error;
    },
    check: (note = "") =>
      action.run(async () => {
        await markChecked(urls(), path(), note);
        onVerified();
      }),
  };
}
