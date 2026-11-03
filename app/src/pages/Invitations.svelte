<script lang="ts">
  import { Tile } from "@tempra/design/components";
  import Avatar from "../Avatar.svelte";
  import { api, post } from "../api";
  import { useAction, useLoad } from "../load.svelte.ts";
  import Moment from "../Moment.svelte";
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
{#if action.error}<div class="notice">{action.error}</div>{/if}
<Status loaded={loaded.current}>
  {#snippet children({ invitations })}
    {#if invitations.length === 0}
      <p>None waiting.</p>
    {:else}
      <ul class="invitations">
        {#each invitations as i (i.id)}
          <li class="invitation">
            <p class="invitation-from">
              <Avatar name={i.handle} /><span
                >@{i.handle} invited you{#if i.created}{" · "}<Moment ts={i.created} />{/if}</span
              >
            </p>
            <div class="invitation-card">
              <Tile letter={tileLetter(i.slug)} shared /><div class="invitation-library">
                <strong>{i.owner}/{i.slug}</strong><span>Open until {day(i.expires)}</span>
              </div>
            </div>
            <p class="invitation-access">
              <span>Your access</span>{i.role === "write" ? "Can read and write" : "Can read and comment"}
            </p>
            <p class="actions">
              <button type="button" class="primary" disabled={action.busy} onclick={() => void answer(i, true)}
                >Accept</button
              ><button type="button" disabled={action.busy} onclick={() => void answer(i, false)}>Decline</button>
            </p>
          </li>
        {/each}
      </ul>
    {/if}
  {/snippet}
</Status>
