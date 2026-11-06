<script lang="ts">
  import { Button } from "@tempra/design/components";
  import type { LedgerRequest } from "../activity";
  import { useAgentNames } from "../agents.svelte.ts";
  import { api, field, post } from "../api";
  import ConfirmDialog from "../ConfirmDialog.svelte";
  import { useConfirm } from "../confirm.svelte.ts";
  import { useAction, useLoad } from "../load.svelte.ts";
  import Moment from "../Moment.svelte";
  import { useRole } from "../role.svelte.ts";
  import Status from "../Status.svelte";
  import { localTime, plural } from "../ui";
  import { useMe } from "../ui.svelte.ts";
  import type { Urls } from "../urls";
  import { forOwner, type RestoreRow, restoreTime } from "./manage";

  /**
   * The Settings page's Recovery section (the owner's alone, Settings.svelte): point-in-time
   * restore of the whole library, and undoing one.
   */
  let { urls }: { urls: Urls } = $props();
  const role = useRole(() => urls);
  const loaded = useLoad(
    () => `recovery ${urls.base} ${role.current}`,
    () =>
      forOwner(role.current, async () => {
        const [recent, restores] = await Promise.all([
          api<{ requests: LedgerRequest[] }>(urls.api("requests", { limit: 10 })),
          api<{ restores: RestoreRow[] }>(urls.api("restores")),
        ]);
        return { recent: recent.requests, restores: restores.restores };
      }),
  );
  /** "you" for the signed-in person, an agent by its name, another person by their handle. */
  const me = useMe();
  const names = useAgentNames(() => urls);
  const name = (actor: string, by?: LedgerRequest["by"]) =>
    me.current && actor === me.current.actor && !by?.agent ? "you" : names.label(actor, by);
  const action = useAction();
  const c = useConfirm();
  /** What the last action did: a line, or the moment a restore went back to. */
  let result = $state.raw<string | { restored: string } | null>(null);
  /** The moment a confirmation is about. */
  let restoreTo = $state("");

  function restore(e: SubmitEvent & { currentTarget: HTMLFormElement }) {
    e.preventDefault();
    const raw = field(e.currentTarget, "to");
    // The field is the person's local time; the server takes an ISO moment.
    const at = new Date(raw);
    if (Number.isNaN(at.getTime())) {
      action.setError("Choose a date and time.");
      return;
    }
    const to = at.toISOString();
    restoreTo = to;
    c.confirm({
      title: "Restore this library?",
      body: restoreBody,
      action: "Restore",
      run: () =>
        action.run(async () => {
          result = null;
          const r = await post<RestoreRow>(urls.api("restore"), { to });
          result = { restored: r.to };
          loaded.reload();
        }),
    });
  }
  const undo = (r: RestoreRow) =>
    c.confirm({
      title: "Undo this restore?",
      body: undoBody,
      action: "Undo restore",
      run: () =>
        action.run(async () => {
          result = null;
          await post(urls.api("restore"), { undo: r.id });
          result = "Undone: the library is back to how it was before that restore.";
          loaded.reload();
        }),
    });
</script>

{#snippet restoreBody()}
<p>
  Every page goes back to how it was on {localTime(restoreTo)}. What is there now is saved first,
  and you can undo the restore.
</p>
{/snippet}

{#snippet undoBody()}
<p>The library goes back to how it was just before the restore.</p>
{/snippet}

{#snippet nightlyLinks(date: string)}
<a href={urls.nightly(date, "bundle.tar")}>Bundle</a> ·
<a href={urls.nightly(date, "ledger.jsonl")}>History</a>
{/snippet}

<ConfirmDialog asking={c} />
{#if result}
  <div class="notice ok">
    {#if typeof result === "string"}{result}{:else}Restored to {localTime(result.restored)}. What was there before is
      saved under Past restores.{/if}
  </div>
{/if}
{#if action.error}<div class="notice">{action.error}</div>{/if}
<Status loaded={loaded.current}>
  {#snippet children({ recent, restores })}
    <div class="panel-box">
      <h3>Restore this library to a point in time</h3>
      <p>
        Rewinds the whole library to how it was between 2 minutes and 30 days ago. What is there now
        is saved first, and the restore can be undone. To undo one change instead, revert it from
        <a href={urls.activity({ view: "events" })}>Activity, Every event</a>.
      </p>
      <form onsubmit={restore}>
        <p>
          <label class="small">
            Time, in your time zone
            <input type="datetime-local" name="to" step={1} required />
          </label>
        </p>
        <Button variant="primary" type="submit" disabled={action.busy}>Restore…</Button>
      </form>
      {#if recent.length > 0}
        <h3>Latest changes</h3>
        <ul class="small">
          {#each recent as r (r.request_id)}
            <li>
              <span class="muted" title={localTime(r.ts)}>{localTime(r.ts)}</span>
              {name(r.actor, r.by)}{r.note ? `: ${r.note}` : ""}
              <span class="muted">({plural(r.events.length, "change")})</span>
            </li>
          {/each}
        </ul>
      {/if}
    </div>
    <div class="panel-box">
      <h3>Past restores</h3>
      {#if restores.length === 0}
        <p>None.</p>
      {:else}
        <div class="table-wrap">
          <table class="list">
            <thead class="visually-hidden">
              <tr>
                <th>Restore</th>
                <th>What was there before</th>
                <th>Undo</th>
              </tr>
            </thead>
            <tbody>
              {#each restores as r (r.id)}
                <tr>
                  <td
                    ><strong
                      >{r.kind === "undo"
                        ? `Undid the restore made ${localTime(r.undoes ? restoreTime(r.undoes) : r.to)}`
                        : `Restored to ${localTime(r.to)}`}</strong
                    ><div class="small muted"><Moment ts={r.requested_at} />, by {name(r.actor)}</div></td
                  >
                  <td class="small">
                    Before it: {@render nightlyLinks(r.export.split("/").at(-2) ?? "")}
                  </td>
                  <td>
                    <Button disabled={action.busy} onclick={() => undo(r)}>Undo…</Button>
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      {/if}
    </div>
  {/snippet}
</Status>
