<script lang="ts">
  import { tick } from "svelte";
  import type { MenuProps } from "./types";

  /**
   * A button that opens a list of links under it. It closes on a choice, a click elsewhere,
   * Escape or the focus leaving it, and gives the focus back to its button. Down (or Up) on the
   * button opens it at its first (or last) choice; in the list Up, Down, Home and End move
   * between the choices (F-16, TEMPRA-133).
   */
  let props: MenuProps = $props();

  const id = $props.id();
  let open = $state(false);
  let box: HTMLDivElement | undefined = $state();
  let button: HTMLButtonElement | undefined = $state();

  function setOpen(next: boolean) {
    if (next === open) return;
    open = next;
  }

  /** The choices in the list that take the keys: its links and enabled buttons, as shown. */
  function choices(): HTMLElement[] {
    const list = document.getElementById(id);
    if (!list) return [];
    return Array.from(list.querySelectorAll<HTMLElement>("a[href], button:not([disabled])")).filter(
      (el) => el.getClientRects().length > 0,
    );
  }

  function focusChoice(which: "first" | "last") {
    const items = choices();
    (which === "first" ? items[0] : items[items.length - 1])?.focus();
  }

  const MENU_KEYS: ReadonlySet<string> = new Set(["ArrowDown", "ArrowUp", "Home", "End"]);

  async function onkeydown(e: KeyboardEvent) {
    if (!MENU_KEYS.has(e.key) || e.altKey || e.ctrlKey || e.metaKey) return;
    const t = e.target as Element;
    if (t.closest("input, textarea, select")) return;
    if (t === button) {
      if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
      e.preventDefault();
      const which = e.key === "ArrowDown" ? "first" : "last";
      if (!open) {
        setOpen(true);
        await tick();
      }
      focusChoice(which);
      return;
    }
    const items = choices();
    if (items.length === 0) return;
    e.preventDefault();
    const at = items.indexOf(document.activeElement as HTMLElement);
    const next =
      e.key === "Home"
        ? 0
        : e.key === "End"
          ? items.length - 1
          : e.key === "ArrowDown"
            ? (at + 1) % items.length
            : (at - 1 + items.length) % items.length;
    items[next]?.focus();
  }

  $effect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      if (!box?.contains(e.target as Node)) setOpen(false);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      setOpen(false);
      button?.focus();
    };
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", key, true);
    return () => {
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("keydown", key, true);
    };
  });
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="menu"
  bind:this={box}
  {onkeydown}
  onfocusout={(e) => {
    // The focus moving to something outside (Tab, a click on a control) closes it; a click on
    // the list's own ground, which leaves the focus nowhere, does not.
    const to = e.relatedTarget;
    if (open && to instanceof Node && !box?.contains(to)) setOpen(false);
  }}
>
  <button
    bind:this={button}
    type="button"
    class={props.buttonClass ?? "menu-button"}
    aria-expanded={open}
    aria-controls={id}
    aria-label={props.name}
    title={props.title}
    onclick={() => setOpen(!open)}
  >
    {@render props.label()}
  </button
  >{#if open}
    <!-- A choice (a link or a button in the list) closes the menu. -->
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <div
      {id}
      class={`menu-list ${props.align ?? "start"}${props.up ? " up" : ""}${props.listClass ? ` ${props.listClass}` : ""}`}
      onclick={(e) => {
        const choice = (e.target as Element).closest("a, button");
        if (!choice || choice.hasAttribute("data-stay")) return;
        // A button that submits a form (Sign out) closes the menu after the click: closing at
        // once takes the form out of the page before the browser submits it.
        if (choice instanceof HTMLButtonElement && choice.type === "submit" && choice.form) {
          setTimeout(() => setOpen(false));
        } else {
          setOpen(false);
        }
      }}
    >
      {@render props.children(() => setOpen(false))}
    </div>
  {/if}
</div>
