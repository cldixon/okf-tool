<script lang="ts">
  import { ComposeDialog, PillButton, Tile } from "@tempra/design/components";
  import { untrack } from "svelte";
  import { api, field, post } from "../api";
  import { useAction, useLoad } from "../load.svelte.ts";
  import PageBar from "../PageBar.svelte";
  import { isShared, libraryLabel } from "../role";
  import { navigate } from "../router";
  import Status from "../Status.svelte";
  import { tileLetter } from "../ui";
  import { useMe, useTitle } from "../ui.svelte.ts";
  import { Urls } from "../urls";
  import { cardFacts, type Library, slugFrom } from "./libraries";

  /**
   * The account's libraries (take 4, board 01): cards under Yours and Shared with you, each with
   * its title, what is for the person there, its description and one line of facts; New library
   * in the top bar, and on a phone a button floating at the screen's bottom right instead
   * (TEMPRA-148); the switcher's menu lands here with ?new=1.
   */
  let { create }: { create: boolean } = $props();
  useTitle(() => "Libraries");
  const loaded = useLoad(
    () => "libraries",
    () => api<{ libraries: Library[] }>("/api/v1/libraries").then((r) => r.libraries),
  );
  let creating = $state(untrack(() => create));
  const invited = useLoad(
    () => "invitations",
    () => api<{ invitations: unknown[] }>("/api/v1/invitations"),
  );
  const waiting = $derived(invited.data?.invitations.length ?? 0);

  /**
   * New library, as a compose dialog over the list: its name, a description, and its address
   * (filled in from the name until the person edits it). Creating opens the new library.
   */
  const me = useMe();
  let title = $state("");
  let slug = $state<string | null>(null);
  const action = useAction();
  const address = $derived(slug ?? slugFrom(title));
  function close() {
    title = "";
    slug = null;
    action.setError(null);
    creating = false;
  }
  function submit(e: SubmitEvent & { currentTarget: HTMLFormElement }) {
    e.preventDefault();
    const description = field(e.currentTarget, "description").replace(/\s+/g, " ");
    void action.run(async () => {
      const lib = await post<Library>("/api/v1/libraries", {
        slug: address,
        title: title.trim() || undefined,
        description: description || undefined,
      });
      navigate(new Urls(lib.owner, lib.slug).tree(""));
    });
  }
</script>

{#snippet newLibrary(className: string)}
  <PillButton icon="plus" label="New library" class={className} aria-haspopup="dialog" onclick={() => (creating = true)} />
{/snippet}

{#snippet barNew()}{@render newLibrary("tool-pill primary bar-new")}{/snippet}

<!-- One section of cards; a library as a card: a quiet cover with its tile, then its name, description and facts. -->
{#snippet cards(heading: string, libraries: Library[])}
  <section aria-label={heading}>
    <h2 class="lib-section-title">{heading}</h2>
    <ul class="lib-cards">
      {#each libraries as l (l.id)}
        {@const facts = cardFacts(l)}
        <li>
          <a class="lib-card" href={new Urls(l.owner, l.slug).tree("")}
            ><span class="lib-card-cover"><Tile letter={tileLetter(l.title || l.slug)} size="large" shared={isShared(l)} /></span
            ><span class="lib-card-body"
              ><span class="lib-card-name"><span>{libraryLabel(l)}</span></span
              >{#if l.description}<span class="lib-card-desc">{l.description}</span>{/if}{#if facts.length > 0}<span
                  class="lib-card-meta">{facts.join(" · ")}</span
                >{/if}</span
            ></a
          >
        </li>
      {/each}
    </ul>
  </section>
{/snippet}

<PageBar actions={barNew} />
{@render newLibrary("primary fab")}
<h1>Libraries</h1>
<ComposeDialog
  open={creating}
  onClose={close}
  title="New library"
  action="Create library"
  busy={action.busy}
  error={action.error}
  onSubmit={submit}
>
  {#snippet context()}{me.current ? `@${me.current.handle}` : "You"}{/snippet}
  {#snippet fields()}
    <label class="compose-field">
      <span class={me.current ? "compose-prefix" : undefined}>{me.current ? `${me.current.handle}/` : "Address"}</span>
      <input
        name="slug"
        type="text"
        aria-label="Address"
        placeholder="team-notes"
        required
        pattern={"[a-z0-9][a-z0-9\\-]{0,62}"}
        title="Lowercase letters, digits and dashes"
        value={address}
        oninput={(e) => (slug = e.currentTarget.value)}
      />
    </label>
  {/snippet}
  <input
    class="compose-title"
    name="title"
    type="text"
    aria-label="Name"
    placeholder="Library name"
    maxlength={120}
    autocomplete="off"
    data-autofocus="true"
    bind:value={title}
  />
  <textarea
    class="compose-text"
    name="description"
    aria-label="Description"
    placeholder="Add a description…"
    maxlength={300}
    rows={3}
  ></textarea>
</ComposeDialog>
{#if waiting > 0}
  <p>
    <a href="/invitations">{waiting === 1 ? "An invitation" : `${waiting} invitations`} to a library</a>
    {waiting === 1 ? "is" : "are"} waiting for you.
  </p>
{/if}
<Status loaded={loaded.current}>
  {#snippet children(libs)}
    {@const yours = libs.filter((l) => !isShared(l))}
    {@const shared = libs.filter(isShared)}
    {#if libs.length === 0}<p class="muted">No libraries yet.</p>{/if}
    {#if yours.length > 0}{@render cards("Yours", yours)}{/if}
    {#if shared.length > 0}{@render cards("Shared with you", shared)}{/if}
  {/snippet}
</Status>
