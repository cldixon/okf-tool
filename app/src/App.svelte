<script lang="ts" module>
  import { lazy } from "./chunks";

  /**
   * The settings pages' chunk, fetched once, on the first settings page (pages/settings.ts). A
   * tab from before a deploy asks for a name the new build does not serve; `lazy` then loads the
   * page afresh, once (chunks.ts), rather than leave it blank.
   */
  const settings = lazy(() => import("./pages/settings"));

  /** The components' catalogue (/_dev/design, local dev only), a chunk of its own. */
  const design = lazy(() => import("./pages/Design.svelte"));

  /** The pages that lay out their column themselves (a page's columns, the person's views). */
  const OWN_COLUMN = new Set(["file", "directory", "activity"]);
</script>

<script lang="ts">
  import { Button, Notice } from "@tempra/design/components";
  import AccountFrame from "./AccountFrame.svelte";
  import type { AccountPage, Place } from "./frame";
  import { here } from "./location.svelte.ts";
  import PageColumn from "./PageColumn.svelte";
  import Activity from "./pages/Activity.svelte";
  import File from "./pages/File.svelte";
  import Home from "./pages/Home.svelte";
  import Libraries from "./pages/Libraries.svelte";
  import Redirect from "./Redirect.svelte";
  import { match, pageKey } from "./router";
  import { useMe } from "./ui.svelte.ts";
  import { type Urls, urlsFor } from "./urls";
  import Workspace from "./Workspace.svelte";

  const me = useMe();
  // The page on screen draws from `here.url`; the frame follows the address, which can be ahead of
  // it for a moment while the next page's data arrives (TEMPRA-194, hold.ts).
  const url = $derived(here.url);
  const route = $derived(match(url));
  const address = $derived(match(here.address));
  const actor = $derived(me.current?.actor ?? "");
  const key = $derived(pageKey(url, route));

  /** For the account's pages: which one, for its frame. */
  const account = $derived.by((): AccountPage | null => {
    switch (address?.page) {
      case "libraries":
      case "welcome":
      case "agents":
      case "account":
      case "invitations":
        return address.page;
      case "redirect":
        return "libraries";
      default:
        return null;
    }
  });

  /** For a library's pages: the library and where in it the page is (the workspace frame). */
  const library = $derived.by((): { urls: Urls; place: Place } | null => {
    const r = address;
    if (!r || !("owner" in r)) return null;
    const place: Place = { file: null, dir: null, view: null };
    switch (r.page) {
      case "directory":
        if (r.dir === "") place.view = "home";
        else place.dir = r.dir;
        break;
      case "file":
      case "diff":
      case "restore":
        place.file = r.path;
        break;
      case "revert":
        place.view = "activity";
        break;
      case "activity":
      case "settings":
        place.view = r.page;
    }
    return { urls: urlsFor(r.owner, r.slug, undefined), place };
  });
  // Each its own derived, so a navigation that keeps the library keeps the same Urls (a derived
  // passes on a change only when its value is a new one): the frame's loads are not redone.
  const libraryUrls = $derived(library?.urls ?? null);
  const pinnedUrls = $derived(
    route && "owner" in route
      ? urlsFor(route.owner, route.slug, "at" in route ? route.at : undefined)
      : null,
  );
  const place = $derived(library?.place ?? null);
  const libraryKey = $derived(libraryUrls ? `${libraryUrls.owner}/${libraryUrls.slug}` : "");
</script>

{#snippet page()}
  <!-- Keeps a failure in one page from blanking the app: the page shows an error instead, and
       the frame still works. Keyed by the URL, so moving to another page starts afresh. -->
  {#key key}
    <svelte:boundary onerror={(e) => console.error(e)}>
      {@render body()}
      {#snippet failed(error)}
        <h1>Something went wrong</h1>
        <p class="muted">{error instanceof Error ? error.message : String(error)}</p>
        <p><a href={location.href}>Reload the page</a></p>
      {/snippet}
    </svelte:boundary>
  {/key}
{/snippet}

<!-- A part of the app that would not load even after the page loaded afresh (chunks.ts). -->
{#snippet chunkFailed()}
  <Notice>This page didn't load. Reload to try again.</Notice>
  <p><Button href={location.href}>Reload</Button></p>
{/snippet}

{#snippet body()}
  {#if !route}
    <!-- The Worker serves this page only at the app's own URLs, so this is a bug, not a 404. -->
    <h1>Not found</h1>
  {:else if route.page === "libraries"}
    <Libraries create={route.create} />
  {:else if route.page === "welcome"}
    {#await settings() then S}<S.Welcome me={me.current} />{:catch}{@render chunkFailed()}{/await}
  {:else if route.page === "agents"}
    {#await settings() then S}<S.Agents me={me.current} newToken={route.newToken} library={route.library} />{:catch}{@render chunkFailed()}{/await}
  {:else if route.page === "account"}
    {#await settings() then S}<S.Account done={route.done} />{:catch}{@render chunkFailed()}{/await}
  {:else if route.page === "invitations"}
    {#await settings() then S}<S.Invitations />{:catch}{@render chunkFailed()}{/await}
  {:else if route.page === "redirect"}
    <Redirect to={route.to} />
  {:else if pinnedUrls}
    {@const urls = pinnedUrls}
    {#if route.page === "directory"}
      {#if route.dir === ""}
        <Home {urls} />
      {:else}
        <!-- A folder's address (TEMPRA-138): a folder is a group in the tree, not a page, so its
             address opens the home; the workspace hands the folder to the tree (`place.dir`). -->
        <Redirect to={urls.pinned(undefined).tree("")} />
      {/if}
    {:else if route.page === "activity"}
      <Activity {urls} filters={route.filters} done={route.done} />
    {:else if route.page === "file"}
      <File {urls} path={route.path} done={url.searchParams.get("done")} {actor} compare={route.compare ?? null} />
    {:else if route.page === "diff"}
      <!-- The take 3 Diff page is retired (TEMPRA-124): its address opens the page's own
           version view. -->
      <Redirect to={urls.diff(route.path, route.from, route.to)} />
    {:else if route.page === "settings"}
      {#await settings() then S}<S.Settings {urls} me={me.current?.handle ?? null} section={route.section} />{:catch}{@render chunkFailed()}{/await}
    {:else if route.page === "revert"}
      {#await settings() then S}<S.Revert {urls} request={route.request} />{:catch}{@render chunkFailed()}{/await}
    {:else if route.page === "restore"}
      {#await settings() then S}<S.Restore {urls} path={route.path} to={route.to} />{:catch}{@render chunkFailed()}{/await}
    {/if}
  {/if}
{/snippet}

{#if route?.page === "design"}
  <!-- The catalogue draws every component in light and dark, with no frame around it. -->
  {#await design() then D}<D.default />{:catch}{@render chunkFailed()}{/await}
{:else if libraryUrls && place}
  <!-- A library's pages share one workspace, kept mounted while the person moves within it. -->
  {#key libraryKey}
    <Workspace urls={libraryUrls} {place} me={me.current}>
      {#if route && OWN_COLUMN.has(route.page)}
        {@render page()}
      {:else}
        <PageColumn>{@render page()}</PageColumn>
      {/if}
    </Workspace>
  {/key}
{:else}
  <!-- The account's pages share its frame. -->
  <AccountFrame page={account ?? "libraries"} me={me.current}>
    <PageColumn>{@render page()}</PageColumn>
  </AccountFrame>
{/if}
