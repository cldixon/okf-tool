<script lang="ts">
  import { Button, Field } from "@tempra/design/components";
  import { field, post } from "../api";
  import { useAction } from "../load.svelte.ts";
  import type { Urls } from "../urls";

  /**
   * The Settings page's last section, the owner's alone (Settings.svelte): deleting the library,
   * typing its name (v2 spec: Accounts).
   */
  let { urls }: { urls: Urls } = $props();
  const action = useAction();

  function submit(e: SubmitEvent & { currentTarget: HTMLFormElement }) {
    e.preventDefault();
    const confirm = field(e.currentTarget, "confirm");
    void action.run(async () => {
      if (confirm !== urls.slug) throw new Error(`Type ${urls.slug} to confirm.`);
      await post(urls.api("delete"), { confirm });
      // A full load: the library list, or first run if it was the last one.
      location.assign("/");
    });
  }
</script>

{#if action.error}<div class="notice">{action.error}</div>{/if}
<p>
  Deletes every page, attachment, export and token of this library.
  <a href={urls.exportTar()}>Export it first</a>.
</p>
<form onsubmit={submit}>
  <Field label={`Type ${urls.slug} to confirm`}
    ><input type="text" name="confirm" autocomplete="off" required /></Field
  >
  <p>
    <Button type="submit" disabled={action.busy}>Delete library</Button>
  </p>
</form>
