<script lang="ts">
  import { Button } from "@tempra/design/components";
  import { field, post } from "../api";
  import { useAction } from "../load.svelte.ts";
  import { librariesChanged } from "../role";
  import { useLibrary, useRole } from "../role.svelte.ts";
  import type { Urls } from "../urls";

  /**
   * General, the Settings page's first section (TEMPRA-102): the library's title and
   * description, which the owner edits under the limits create_library enforces; a write member
   * reads them. A read member's settings are Members alone (Settings.svelte).
   */
  let { urls }: { urls: Urls } = $props();
  const library = useLibrary(() => urls);
  const lib = $derived(library.current);
  const role = useRole(() => urls);
  const action = useAction();
  let notice = $state<string | null>(null);

  function save(e: SubmitEvent & { currentTarget: HTMLFormElement }) {
    e.preventDefault();
    const form = e.currentTarget;
    const title = field(form, "title");
    const description = field(form, "description");
    void action.run(async () => {
      await post(
        urls.apiRoot(),
        { title: title || null, description: description || null },
        "PATCH",
      );
      notice = "Saved.";
      librariesChanged();
    });
  }
</script>

{#if role.current === null || role.current === "read"}
  <p class="muted">Loading…</p>
{:else}
  {#if notice}<div class="notice ok">{notice}</div>{/if}
  {#if action.error}<div class="notice">{action.error}</div>{/if}
  {#if role.current === "owner"}
    {#key `${lib?.title}|${lib?.description}`}
      <form class="stack" onsubmit={save}>
        <p class="field">
          <label for="library-title">Title</label><input
            id="library-title"
            name="title"
            type="text"
            maxlength={120}
            defaultValue={lib?.title ?? ""}
            placeholder={urls.slug}
          />
        </p>
        <p class="field">
          <label for="library-description">Description</label><input
            id="library-description"
            name="description"
            type="text"
            maxlength={300}
            defaultValue={lib?.description ?? ""}
            placeholder="What this library is for, in one line"
          />
        </p>
        <p class="small muted">The library's address stays {urls.owner}/{urls.slug}.</p>
        <p>
          <Button variant="primary" type="submit" disabled={action.busy}>Save</Button>
        </p>
      </form>
    {/key}
  {:else}
    <dl class="facts">
      <dt>Title</dt>
      <dd>{#if (lib?.title ?? null) !== null}{lib?.title}{:else}<span class="muted">{urls.slug}</span>{/if}</dd>
      <dt>Description</dt>
      <dd>
        {#if (lib?.description ?? null) !== null}{lib?.description}{:else}<span class="muted">None</span>{/if}
      </dd>
      <dt>Address</dt>
      <dd>{urls.owner}/{urls.slug}</dd>
    </dl>
  {/if}
{/if}
