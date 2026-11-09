<script lang="ts">
  import { Button, Field } from "@tempra/design/components";
  import { type LedgerRequest, touchedBy } from "../activity";
  import { useAgentNames } from "../agents.svelte.ts";
  import { api, field, post } from "../api";
  import { useTitleOf } from "../frame.svelte.ts";
  import { useAction, useLoad } from "../load.svelte.ts";
  import Moment from "../Moment.svelte";
  import { useLibraryTitle, useRole } from "../role.svelte.ts";
  import { navigate } from "../router";
  import Status from "../Status.svelte";
  import { useMe } from "../ui.svelte.ts";
  import type { Urls } from "../urls";
  import { folderOf, forOwner, WHAT_WORDS } from "./manage";
  import OwnerOnly from "./OwnerOnly.svelte";

  /** Undoing one change (a ledger request), as a new change by the owner (owner only). */
  let { urls, request }: { urls: Urls; request: string } = $props();
  useLibraryTitle(
    () => urls,
    () => "Revert",
  );
  const role = useRole(() => urls);
  const loaded = useLoad(
    () => `revert ${urls.revert(request)} ${role.current}`,
    () =>
      forOwner(role.current, () =>
        api<LedgerRequest>(urls.api(`requests/${encodeURIComponent(request)}`)),
      ),
  );
  const titles = useTitleOf();
  /** "you" for the signed-in person, an agent by its name, another person by their handle. */
  const me = useMe();
  const names = useAgentNames(() => urls);
  const name = (actor: string, by?: LedgerRequest["by"]) =>
    me.current && actor === me.current.actor && !by?.agent ? "you" : names.label(actor, by);
  const action = useAction();

  function submit(e: SubmitEvent & { currentTarget: HTMLFormElement }) {
    e.preventDefault();
    const note = field(e.currentTarget, "note");
    void action.run(async () => {
      const res = await post<{ results: unknown[] }>(urls.api("revert"), {
        request_id: request,
        note,
      });
      navigate(`${urls.ledger()}?done=revert&n=${res.results.length}`);
    });
  }
</script>

<OwnerOnly {urls}>
  <Status loaded={loaded.current}>
    {#snippet children(r)}
      {@const touched = touchedBy(r.events, titles.of)}
      <h1>Revert this change?</h1>
      <p>
        By {name(r.actor, r.by)}, <Moment ts={r.ts} />{r.note ? `: ${r.note}` : ""}
      </p>
      <ul class="events">
        {#each touched as t (t.path)}
          <li>
            {WHAT_WORDS[t.what]}
            <a href={t.what === "deleted" ? urls.pinned(t.seq - 1).file(t.path) : urls.since(t.path, t.seq)}
              >{t.title}</a
            >{#if t.from}<span class="muted">{` from ${folderOf(t.from)}`}</span>{/if}
          </li>
        {/each}
      </ul>
      <div class="panel-box">
        <p>Undoes every change in it, as a new change by you. Nothing is erased.</p>
        {#if action.error}<div class="notice">{action.error}</div>{/if}
        <form onsubmit={submit}>
          <Field label="Note"
            ><input type="text" name="note" defaultValue={`Revert: ${r.note ?? "a change"}`} /></Field
          >
          <p class="actions">
            <Button variant="primary" type="submit" disabled={action.busy}>Revert</Button><Button href={urls.activity({ view: "events" })}>Cancel</Button>
          </p>
        </form>
      </div>
    {/snippet}
  </Status>
</OwnerOnly>
