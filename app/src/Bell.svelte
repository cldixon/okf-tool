<script lang="ts">
  import { Badge, Icon, Menu } from "@tempra/design/components";
  import BellList from "./BellList.svelte";
  import { useOpenCount } from "./inbox.svelte.ts";

  /**
   * The bell (TEMPRA-189): the person's notifications, on every page. What waits is a badge; the
   * panel under it lists it, so a look never leaves the page. The count follows the feed and every
   * action on an item.
   */
  const open = useOpenCount();
  const n = $derived(open.current);
</script>

<Menu
  name={n > 0 ? `Notifications, ${n} waiting` : "Notifications"}
  title="Notifications"
  buttonClass="icon-button bell"
  listClass="bell-pop"
  align="end"
>
  {#snippet label()}
    <Icon name="bell" />
    <Badge count={n} />
  {/snippet}
  {#snippet children(close: () => void)}
    <BellList {close} />
  {/snippet}
</Menu>
