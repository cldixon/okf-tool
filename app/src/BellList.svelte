<script lang="ts">
  import { Tile } from "@tempra/design/components";
  import { api, post } from "./api";
  import {
    INBOX_EVENT,
    type InboxItem,
    type InboxPage,
    inboxChanged,
    itemDetail,
    itemHref,
    itemLibrary,
    itemTitle,
    markDone,
    withNames,
  } from "./inbox";
  import { useAgentLabels, usePageTitles } from "./inbox.svelte.ts";
  import { useAction, useLoad } from "./load.svelte.ts";
  import Moment from "./Moment.svelte";
  import { librariesChanged } from "./role";
  import { navigate } from "./router";
  import { tileLetter } from "./ui";
  import { useMe } from "./ui.svelte.ts";
  import { urlsOf } from "./urls";

  /**
   * The bell's panel is the person's notifications (TEMPRA-189; tempra-dev: v2/notifications):
   * what waits, newest first. A reply or a mention is a link to its thread, done as it is opened;
   * an invitation is answered here, Accept opening the library; a monthly quota at 80% or 100%
   * (TEMPRA-232) opens the Account page's usage, done as it is opened. Nothing else: there is no
   * Inbox page, no Earlier and no filter.
   */
  let { close }: { close: () => void } = $props();

  const SHOWN = 20;
  const loaded = useLoad(
    () => "notifications",
    () => api<InboxPage>(`/api/v1/inbox?limit=${SHOWN}`),
    [INBOX_EVENT],
  );
  const raw = $derived(loaded.data?.items ?? null);
  const labels = useAgentLabels(() => raw);
  const items = $derived(raw && withNames(raw, labels.current));
  const titles = usePageTitles(() => items);
  const me = useMe();
  const handle = $derived(me.current?.handle ?? null);
  const more = $derived((loaded.data?.open ?? 0) - (items?.length ?? 0));
  const action = useAction();
  const invitation = (i: InboxItem, answer: "accept" | "decline") =>
    `/api/v1/invitations/${encodeURIComponent(i.invitation ?? "")}/${answer}`;
  const accept = (i: InboxItem) =>
    void action.run(async () => {
      await post(invitation(i, "accept"), {});
      librariesChanged();
      inboxChanged();
      close();
      navigate(urlsOf(i.library).tree(""));
    });
  const decline = (i: InboxItem) =>
    void action.run(async () => {
      await post(invitation(i, "decline"), {});
      inboxChanged();
    });
</script>

<p class="bell-head">Notifications</p>
{#if loaded.state === "loading" && items === null}
  <p class="bell-empty">Loading…</p>
{:else if loaded.state === "error" && items === null}
  <p class="bell-empty" role="alert">Couldn't load notifications.</p>
{:else if !items || items.length === 0}
  <p class="bell-empty">No notifications</p>
{:else}
  {#each items as i (i.id)}
    {#snippet about()}
      {#if i.kind === "quota"}
        <Tile letter="T" size="small" />
      {:else}
        <Tile letter={tileLetter(i.library_title || urlsOf(i.library).slug)} size="small" shared={handle !== null && urlsOf(i.library).owner !== handle} />
      {/if}
      <span class="bell-item-what"><strong>{itemTitle(i, titles.current)}</strong><span class="bell-item-detail">{itemDetail(i)}</span></span>
      <span class="bell-item-where">{itemLibrary(i, handle)}{" · "}<Moment ts={i.created} /></span>
    {/snippet}
    {#if i.kind === "invitation" && i.invitation}
      <div class="bell-item">
        {@render about()}
        <span class="bell-item-actions"
          ><button type="button" class="primary" data-stay disabled={action.busy} onclick={() => accept(i)}>Accept</button
          ><button type="button" data-stay disabled={action.busy} onclick={() => decline(i)}>Decline</button></span
        >
      </div>
    {:else}
      <a class="bell-item" href={itemHref(i)} onclick={() => void markDone(i.id)}>{@render about()}</a>
    {/if}
  {/each}
  {#if more > 0}<p class="bell-more">{more} more</p>{/if}
{/if}
{#if action.error}<p class="bell-error" role="alert">{action.error}</p>{/if}
