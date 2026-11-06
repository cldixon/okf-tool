<script lang="ts">
  import { Button, Notice, Tile } from "@tempra/design/components";
  import { api, post } from "../api";
  import { useAction, useLoad } from "../load.svelte.ts";
  import Moment from "../Moment.svelte";
  import { libraryLabel } from "../role";
  import Status from "../Status.svelte";
  import { day, tileLetter } from "../ui";
  import { useTitle } from "../ui.svelte.ts";
  import { Urls } from "../urls";
  import type { PendingInvitation } from "./account";

  /** Invitations to other people's libraries (tempra-dev: v2/sharing), to accept or decline. */
  useTitle(() => "Invitations");
  const loaded = useLoad(
    () => "invitations",
    () => api<{ invitations: PendingInvitation[] }>("/api/v1/invitations"),
  );
  const action = useAction();
  const answer = (i: PendingInvitation, accept: boolean) =>
    action.run(async () => {
      await post(
        `/api/v1/invitations/${encodeURIComponent(i.id)}/${accept ? "accept" : "decline"}`,
      );
      if (accept) {
        // A full load: the library list and the workspace learn the new library.
        location.assign(new Urls(i.owner, i.slug).tree(""));
        return;
      }
      loaded.reload();
    });
</script>

<h1>Invitations</h1>
{#if action.error}<Notice>{action.error}</Notice>{/if}
<Status loaded={loaded.current}>
  {#snippet children({ invitations })}
    {#if invitations.length === 0}
      <p class="view-empty">No invitations</p>
    {:else}
      <!-- One row each, as the bell's: the library's tile and name, who invited and when, the
           access offered, then Accept and Decline in place. -->
      <ul class="invitations">
        {#each invitations as i (i.id)}
          <li class="invitation">
            <Tile letter={tileLetter(i.title || i.slug)} shared /><div class="invitation-about">
              <strong class="invitation-library">{libraryLabel(i)}</strong><span
                class="invitation-from">@{i.handle} invited you{#if i.created}{" · "}<Moment ts={i.created} />{/if}</span
              ><span class="invitation-access"
                >{i.role === "write" ? "Can read and write" : "Can read and comment"}{` · open until ${day(i.expires)}`}</span
              >
            </div>
            <span class="invitation-actions"
              ><Button variant="primary" disabled={action.busy} onclick={() => void answer(i, true)}>Accept</Button><Button
                disabled={action.busy}
                onclick={() => void answer(i, false)}>Decline</Button
              ></span
            >
          </li>
        {/each}
      </ul>
    {/if}
  {/snippet}
</Status>
