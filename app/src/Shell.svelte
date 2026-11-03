<script lang="ts" module>
  import type { Urls } from "./urls";

  /** The library a frame is about: its name, its address, whether it is shared, on its home. */
  export interface BrandLibrary {
    urls: Urls;
    name: string;
    shared: boolean;
    home: boolean;
  }

  /** Where the page was scrolled on each URL, for back and forward. */
  const scrolls = new Map<string, number>();
</script>

<script lang="ts">
  import { type Snippet, untrack } from "svelte";
  import AccountMenu from "./AccountMenu.svelte";
  import Bell from "./Bell.svelte";
  import Brand from "./Brand.svelte";
  import { NARROW } from "./frame";
  import { provideFrame, useMedia } from "./frame.svelte.ts";
  import { Icon, IconButton } from "@tempra/design/components";
  import { usePrefetchLinks } from "./links.svelte.ts";
  import { here } from "./location.svelte.ts";
  import { lastNavigation } from "./router";
  import type { OutlineFile } from "./tree";
  import type { Me } from "./ui";

  /*
   * The app's frame (take 4, TEMPRA-113; tempra-dev: app/workspace): a top bar across the window,
   * split at the sidebar's edge (the Tempra mark, the library's name with its switcher, and search
   * over the sidebar; the page's path, its tools, the bell and the avatar over the page), a
   * navigation sidebar (the tree, and a fixed foot of the library's tools), and the page as a flat
   * column: Linear's docs, translated (TEMPRA-145). A library's pages, its settings and the
   * account's pages all use it, each with its own sidebar. Under 900px the sidebar is a drawer
   * behind the top bar.
   *
   * The frame itself: the top bar, the sidebar (a drawer on a phone), and the page as the frame's
   * scroller. The page scrolls on its own: a new page starts at the top (or its #fragment), and
   * back or forward returns to where the person was on that page.
   */
  let props: {
    /** The library the pages are in (the bar names it, with its switcher); none on account pages. */
    library?: BrandLibrary;
    /** The sidebar's content (the drawer's on a phone); none on a page with no sidebar. */
    sidebar?: Snippet;
    /** Opens search (Ctrl or Cmd+K too): the library's quick switcher, or the libraries'. */
    onSearch?: () => void;
    /** The sidebar can be hidden (a library's own pages): its state and the way to change it. */
    hidden?: boolean;
    onHide?: (hidden: boolean) => void;
    /** A quiet word on the top bar when live updates have stopped (a library's feed, F-19). */
    status?: Snippet;
    me: Me | null;
    /** The library's index, for the pages (null off a library, or until it arrives). */
    index: OutlineFile[] | null;
    /** The path of the page being moved to, drawn while the page on screen waits for it. */
    nextPath?: Snippet;
    children: Snippet;
  } = $props();

  // A page starts loading when a link to it is pointed at (TEMPRA-193): in a library, its own.
  usePrefetchLinks(() => props.library?.urls ?? null);

  let drawer = $state(false);
  const narrow = useMedia(() => NARROW);
  let sidebar: HTMLElement | undefined = $state();
  let menuButton: HTMLButtonElement | undefined = $state();
  let toolsSlot: HTMLElement | undefined = $state();
  let pathSlot: HTMLElement | undefined = $state();
  let main: HTMLElement | undefined = $state();
  let topbar: HTMLElement | undefined = $state();

  // Modality (C-26, P-1; TEMPRA-133): what the open drawer dims (the top bar and the page), and
  // what a page's overlay dims (the top bar and the sidebar), is inert, so Tab and a screen reader
  // stay in the drawer or the overlay. Set on the elements at once, not on the next render, so
  // the focus can go back to a control in the bar as soon as either closes.
  let modal = false;
  let drawerOpen = false;
  function applyInert() {
    if (topbar) topbar.inert = drawerOpen || modal;
    if (main) main.inert = drawerOpen;
    if (sidebar) sidebar.inert = modal;
  }
  $effect(() => {
    drawerOpen = drawer;
    applyInert();
  });

  const href = $derived(here.url.pathname + here.url.search);
  let shownHref = untrack(() => href);
  $effect(() => {
    const h = href;
    if (shownHref === h) return;
    shownHref = h;
    const el = main;
    if (!el) return;
    const target = lastNavigation() === "pop" ? (scrolls.get(h) ?? 0) : 0;
    el.scrollTop = target;
    if (target === 0) return;
    // The page's body may still be drawing (the reader mounts after this): keep the position
    // until the page is tall enough to hold it, for up to a second, or until the person scrolls.
    const until = performance.now() + 1000;
    let frame = requestAnimationFrame(function again() {
      if (el.scrollTop !== target) el.scrollTop = target;
      if (el.scrollTop !== target && performance.now() < until) {
        frame = requestAnimationFrame(again);
      }
    });
    const stop = () => cancelAnimationFrame(frame);
    const inputs = ["wheel", "touchstart", "keydown", "pointerdown"] as const;
    for (const i of inputs) el.addEventListener(i, stop, { passive: true });
    return () => {
      stop();
      for (const i of inputs) el.removeEventListener(i, stop);
    };
  });

  // The drawer closes when the person moves to another page (at the click, not once the page
  // draws), and when the screen widens.
  const address = $derived(here.address.pathname + here.address.search);
  $effect(() => {
    void address;
    drawer = false;
  });
  $effect(() => {
    if (!narrow.current) drawer = false;
  });
  // An opened drawer takes the focus, unless something in it already has; a tap anywhere else
  // (the dimmed page beside it) closes it, as a tap outside a menu does. Once it closes, the
  // focus it held goes back to the menu button.
  let wasOpen = false;
  $effect(() => {
    const open = drawer;
    const phone = narrow.current;
    if (!open) {
      const focused = document.activeElement;
      const lost = !focused || focused === document.body || sidebar?.contains(focused);
      if (wasOpen && phone && lost) menuButton?.focus();
      wasOpen = false;
      return;
    }
    wasOpen = true;
    if (!sidebar?.contains(document.activeElement)) sidebar?.focus();
    const away = (e: PointerEvent) => {
      const t = e.target instanceof Element ? e.target : null;
      if (!sidebar?.contains(t) && !t?.closest(".ws-menu, dialog")) drawer = false;
    };
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  });

  // Keys: Escape closes the drawer (not from inside a dialog, which handles its own; an open menu
  // takes its Escape first and stops it, and once closed, with the focus on its button in the
  // drawer, the next Escape closes the drawer: TEMPRA-141);
  // Ctrl or Cmd+\ hides the sidebar where it can be hidden (a library's own, not a settings
  // page's or the account's, which are their navigation).
  $effect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target instanceof Element ? e.target : null;
      if (e.key === "Escape" && !e.defaultPrevented && drawer && !t?.closest("dialog")) {
        // Handled: a panel's bottom sheet under the drawer stays open for the next Escape.
        e.preventDefault();
        drawer = false;
      } else if ((e.ctrlKey || e.metaKey) && e.key === "\\" && !narrow.current && props.onHide) {
        e.preventDefault();
        props.onHide(!props.hidden);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  });

  // A page with no sidebar (the library list, TEMPRA-189) has no drawer either: its bar keeps the
  // mark, Tempra and search on a phone too.
  const showSidebar = $derived(!!props.sidebar && (!props.hidden || narrow.current));
  const beside = $derived(showSidebar && !narrow.current);
  const slots = $derived({ tools: toolsSlot ?? null, path: pathSlot ?? null });
  provideFrame({
    get sidebar() {
      return beside;
    },
    get narrow() {
      return narrow.current;
    },
    get index() {
      return props.index;
    },
    get slots() {
      return slots;
    },
    setModal(on: boolean) {
      modal = on;
      applyInert();
    },
    search() {
      props.onSearch?.();
    },
  });
  const classes = $derived(
    [
      "workspace",
      showSidebar ? "" : "sidebar-hidden",
      props.sidebar ? "" : "bare",
      drawer ? "drawer-open" : "",
    ]
      .filter(Boolean)
      .join(" "),
  );
</script>

<div class={classes}>
  <header class="ws-topbar" bind:this={topbar}>
    <!-- Over the sidebar: the mark, the library's name and its switcher, search (TEMPRA-145). -->
    <div class="topbar-brand"><Brand library={props.library} onSearch={props.onSearch} /></div>
    <div class="topbar-page"
      >{#if props.sidebar}<button
        bind:this={menuButton}
        type="button"
        class="icon-button touch ws-menu"
        aria-label="Menu"
        aria-expanded={drawer}
        onclick={() => (drawer = !drawer)}><Icon name="menu" /></button
      >{/if}<!-- On a phone, the mark and the library's name; the page's title names the page
        (TEMPRA-140, TEMPRA-145). --><div class="ws-topbar-place"
        ><Brand library={props.library} short /></div
      >{#if !showSidebar && props.onHide}<IconButton
          icon="sidebar"
          label="Show sidebar"
          class="show-sidebar"
          onclick={() => props.onHide?.(false)}
        />{/if}<!-- The page's path, from the page (a concept's folders and title; TEMPRA-145). --><div
        class="topbar-path"
        bind:this={pathSlot}
        hidden={here.held}
      ></div>{#if here.held}<!-- While the page on screen waits for the next (TEMPRA-194), the
        bar names where the person is going. --><div class="topbar-path">{@render props.nextPath?.()}</div>{/if}<div class="topbar-tools" bind:this={toolsSlot}></div><div class="topbar-end"
        >{@render props.status?.()}<Bell /><AccountMenu me={props.me} /></div
      ></div>
  </header>
  <!-- The page dimmed behind the open drawer; a tap on it closes the drawer. -->
  {#if drawer}<div class="ws-scrim" aria-hidden="true"></div>{/if}
  {#if props.sidebar}<section
    bind:this={sidebar}
    tabindex="-1"
    class={drawer ? "ws-sidebar open" : "ws-sidebar"}
    aria-label="Navigation"
    hidden={!showSidebar}
  >
    <!-- On a phone the drawer's head: the desktop's bar over the sidebar (the mark, the
      library and its switcher, search) and × (TEMPRA-141, TEMPRA-145); then its sidebar. -->
    <div class="drawer-head"
      ><Brand library={props.library} onSearch={props.onSearch} /><IconButton
        icon="close"
        label="Close menu"
        title="Close"
        touch
        class="drawer-close"
        onclick={() => (drawer = false)}
      /></div>
    {@render props.sidebar()}
  </section>{/if}
  <!-- A move that waits past the hold says so, quietly (TEMPRA-194); the page draws Loading…. -->
  <p class="visually-hidden" role="status">{here.loading ? "Loading…" : ""}</p>
  <main class="ws-main" bind:this={main} onscroll={(e) => scrolls.set(href, e.currentTarget.scrollTop)}>
    {@render props.children()}
  </main>
</div>
