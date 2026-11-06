<script lang="ts">
  import { Menu } from "@tempra/design/components";

  /** A Menu holding a form, as the avatar's holds Sign out, and a link. */
  let { onsubmit }: { onsubmit: () => void } = $props();
</script>

<Menu name="Account">
  {#snippet label()}A{/snippet}
  <a class="menu-item" href="/account">Account</a>
  <form
    method="post"
    action="/sign-out"
    onsubmit={(e) => {
      e.preventDefault();
      onsubmit();
    }}
  >
    <button type="submit" class="menu-item">Sign out</button>
  </form>
</Menu>
