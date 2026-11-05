import { api } from "./api";
import { useMe } from "./ui.svelte.ts";

/*
 * The account's theme (take 4, TEMPRA-113; tempra-dev: app/workspace, Theme): System, Light or
 * Dark, stored on the account and put on the shell's root by the server (`data-theme`), so a
 * page never flashes the wrong scheme. The app changes it in place and saves it. Dark when the
 * person never chose (TEMPRA-285): the server puts it on the root and /me answers it.
 */

export type Theme = "system" | "light" | "dark";

export const THEMES: [Theme, string][] = [
  ["system", "System"],
  ["light", "Light"],
  ["dark", "Dark"],
];

/** The theme the root carries now (what the server put there, or the last change). */
export function currentTheme(): Theme {
  const t = document.documentElement.dataset.theme;
  return t === "light" || t === "dark" ? t : "system";
}

/** Puts a theme on the root: the tokens' light-dark() values follow it. */
export function applyTheme(theme: Theme) {
  if (theme === "system") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
  window.dispatchEvent(new Event(THEME_EVENT));
}

const THEME_EVENT = "tempra:theme";

/** The theme as chosen, and a way to choose: applied at once, then saved on the account. */
export function useTheme() {
  const me = useMe();
  let theme = $state<Theme>(currentTheme());
  // The account's choice arrives with /me (a page the server drew before it was changed
  // elsewhere, or a theme set on another device).
  $effect(() => {
    const m = me.current;
    if (m && m.theme !== undefined) {
      const t: Theme = m.theme ?? "dark";
      if (t !== currentTheme()) applyTheme(t);
    }
  });
  $effect(() => {
    const update = () => {
      theme = currentTheme();
    };
    window.addEventListener(THEME_EVENT, update);
    return () => window.removeEventListener(THEME_EVENT, update);
  });
  return {
    get current() {
      return theme;
    },
    choose(t: Theme) {
      applyTheme(t);
      void api("/api/v1/account", {
        method: "PATCH",
        body: JSON.stringify({ theme: t }),
      }).catch(() => {});
    },
  };
}
