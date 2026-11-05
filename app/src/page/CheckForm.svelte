<script lang="ts">
  import { Button } from "@tempra/design/components";
  import { field } from "../api";
  import type { Urls } from "../urls";
  import { useCheck } from "./checked.svelte.ts";

  /** A note and Mark as checked: the person vouches for the version on screen. */
  let { urls, path, onVerified }: { urls: Urls; path: string; onVerified(): void } = $props();
  const check = useCheck(
    () => urls,
    () => path,
    () => onVerified(),
  );
  function submit(e: SubmitEvent & { currentTarget: HTMLFormElement }) {
    e.preventDefault();
    void check.check(field(e.currentTarget, "note"));
  }
</script>

<form class="verify-form" onsubmit={submit}
  ><input type="text" name="note" placeholder="Note (optional)" aria-label="Note" /><Button variant="primary" type="submit" disabled={check.busy}>Mark as checked</Button>{#if check.error}<span class="warn">{check.error}</span>{/if}</form
>
