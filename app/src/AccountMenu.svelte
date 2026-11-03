<script lang="ts">
  import { Icon, Menu } from "@tempra/design/components";
  import Avatar from "./Avatar.svelte";
  import { personInitials } from "./chrome";
  import ThemeChoice from "./ThemeChoice.svelte";
  import { useTheme } from "./theme.svelte.ts";
  import type { Me } from "./ui";

  /**
   * The avatar and its menu (take 4, board 08): who, then Account and Agents; the theme; Sign
   * out. Email settings are on Account (TEMPRA-189).
   */
  let { me }: { me: Me | null } = $props();
  const handle = $derived(me?.handle ?? "");
  /** The account's name, when given (TEMPRA-54): the initials and the menu's first line. */
  const name = $derived(me?.name ?? null);
  const theme = useTheme();
</script>

<Menu title={me ? `${name ?? handle} · ${me.email}` : "Account"} buttonClass="avatar" listClass="account" align="end">
  {#snippet label()}
    <!-- Named by its own words, not an aria-label over the initials (WCAG 2.5.3). -->
    <span aria-hidden="true">{personInitials(handle, name)}</span><span class="visually-hidden">Account menu</span>
  {/snippet}
  <div class="menu-person">
    <Avatar name={handle} fullName={name} />
    <span class="menu-person-names">
      <!-- The name and the handle (TEMPRA-54), or the handle alone, then the email. -->
      <span>{me ? (name ? `${name} · @${handle}` : `@${handle}`) : ""}</span>
      <span class="email">{me?.email ?? ""}</span>
    </span>
  </div>
  <hr />
  <a class="menu-item" href="/account"><Icon name="user" />Account</a>
  <a class="menu-item" href="/agents"><Icon name="plug" />Agents</a>
  <hr />
  <div class="menu-theme">
    <Icon name="theme" />
    <span>Theme</span>
    <ThemeChoice value={theme.current} onChange={theme.choose} />
  </div>
  <hr />
  <form method="post" action="/sign-out">
    <button type="submit" class="menu-item"><Icon name="signout" />Sign out</button>
  </form>
</Menu>
