<script lang="ts">
  import { Button, Field } from "@tempra/design/components";
  import { field, post } from "../api";
  import { useAction } from "../load.svelte.ts";
  import type { Me } from "../ui";
  import { useTitle } from "../ui.svelte.ts";
  import { Urls } from "../urls";

  /**
   * First run (v2 spec: Onboarding): give a name (optional, TEMPRA-54), pick a handle and name
   * the first library, both parts of the library's address (H-12), then land on the new
   * library's home, which shows how to connect an agent and waits for its first write.
   */
  let { me }: { me: Me | null } = $props();
  useTitle(() => "Welcome");
  const action = useAction();

  function submit(e: SubmitEvent & { currentTarget: HTMLFormElement }) {
    e.preventDefault();
    const m = me;
    if (!m) return;
    const form = e.currentTarget;
    const handle = field(form, "handle");
    const name = field(form, "name").trim();
    const slug = field(form, "library");
    const starter = field(form, "starter") === "1";
    void action.run(async () => {
      if (name && name !== (m.name ?? "")) await post("/api/v1/account", { name }, "PATCH");
      if (handle.toLowerCase() !== m.handle)
        await post("/api/v1/account/handle", { handle }, "PUT");
      const lib = await post<{ owner: string; slug: string }>("/api/v1/libraries", {
        slug,
        starter,
      });
      // A full load: the header and links follow the new handle.
      location.assign(new Urls(lib.owner, lib.slug).tree(""));
    });
  }
</script>

{#if !me}
  <p class="muted">Loading…</p>
{:else}
  <h1>Welcome</h1>
  {#if action.error}<div class="notice">{action.error}</div>{/if}
  <form onsubmit={submit}>
    <Field
      label="Name"
      hint="Optional. Your avatar's initials come from it."
      ><input
        type="text"
        name="name"
        defaultValue={me.name ?? ""}
        autocomplete="name"
        maxlength={80}
      /></Field
    >
    <Field
      label="Handle"
      hint={`Part of every library's address: ${location.host}/handle/library. 2 to 39 lowercase letters, digits, - or _.`}
      ><input
        type="text"
        name="handle"
        defaultValue={me.handle}
        required
        autocapitalize="off"
        spellcheck="false"
      /></Field
    >
    <Field
      label="First library"
      hint="The last part of its address. Lowercase letters, digits and -."
      ><input
        type="text"
        name="library"
        defaultValue="notes"
        required
        pattern={"[a-z0-9][a-z0-9\\-]{0,62}"}
        autocapitalize="off"
        spellcheck="false"
      /></Field
    >
    <p>
      <label>
        <input type="checkbox" name="starter" value="1" defaultChecked /> Add a guide page
      </label>
    </p>
    <p>
      <Button variant="primary" type="submit" disabled={action.busy}>Create</Button>
    </p>
  </form>
{/if}
