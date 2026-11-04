<script lang="ts">
  import { Icon, Menu } from "@tempra/design/components";
  import type { Snippet } from "svelte";
  import { plural } from "../ui";

  /*
   * A page's actions (TEMPRA-172; tempra-dev: decisions/a-pages-actions-float): one round + button
   * at the page's bottom right, the one raised thing on a flat page, opening a small menu upward.
   * What it holds depends on the page (TEMPRA-222): Comment (with the open count) everywhere, then
   * what the page adds (`more`: on a page, Check by its state, CheckActions.svelte; on the home,
   * nothing). It steps aside while a panel is open (the panel has its own ×), and comes back,
   * focusable, when the panel closes.
   */
  let props: {
    /** Open threads here. */
    openCount: number;
    /** Something else waits here (on a page, changes since it was checked). */
    waiting?: boolean;
    /** A panel is open: the button steps aside. */
    hidden: boolean;
    onComment(): void;
    /** The page's own actions, after Comment. */
    more?: Snippet;
  } = $props();

  // Something waits here: open comments, or what the page says.
  const waiting = $derived(props.openCount > 0 || props.waiting === true);
  const name = $derived(
    props.openCount > 0 ? `Actions, ${plural(props.openCount, "open comment")}` : "Actions",
  );
</script>

<div class="page-actions" hidden={props.hidden}>
  <Menu {name} title="Actions" buttonClass="page-fab" align="end" up listClass="page-actions-list">
    {#snippet label()}<Icon name="add" size={22} />{#if waiting}<span class="page-fab-dot" aria-hidden="true"></span>{/if}{/snippet}<button type="button" class="menu-item" onclick={() => props.onComment()}
      ><Icon name="comments" /> Comment{#if props.openCount > 0}<span class="menu-count">{props.openCount} open</span>{/if}</button
    >{@render props.more?.()}
  </Menu>
</div>
