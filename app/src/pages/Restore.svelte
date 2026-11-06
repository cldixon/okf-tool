<script lang="ts">
  import { Button } from "@tempra/design/components";
  import { ApiError, api, field, post } from "../api";
  import { useTitleOf } from "../frame.svelte.ts";
  import { useAction, useLoad } from "../load.svelte.ts";
  import Moment from "../Moment.svelte";
  import { useLibraryTitle, useRole } from "../role.svelte.ts";
  import { navigate } from "../router";
  import Status from "../Status.svelte";
  import { enc, type Urls } from "../urls";
  import { forOwner, type HistoryRow, versionAt } from "./manage";
  import OwnerOnly from "./OwnerOnly.svelte";

  /** Writing back one page's earlier version, as a revert by the owner (owner only). */
  let props: { urls: Urls; path: string; to?: number } = $props();
  const titleOf = useTitleOf();
  const title = $derived(titleOf.of(props.path));
  useLibraryTitle(
    () => props.urls,
    () => `Restore ${title}`,
  );
  const role = useRole(() => props.urls);
  const loaded = useLoad(
    () => `restore ${props.urls.base} ${props.path} ${props.to} ${role.current}`,
    () =>
      forOwner(role.current, async () => {
        const { urls, path, to } = props;
        if (to === undefined) throw new ApiError(400, "bad_param", "No version was chosen.");
        const h = await api<{ events: HistoryRow[] }>(urls.api(`history/${enc(path)}`));
        // The version shown at `to`: the latest content event up to it, numbered from the first.
        const v = versionAt(h.events, to);
        if (!v) throw new ApiError(404, "not_found", "That version is not in this page's history.");
        return v;
      }),
  );
  const action = useAction();

  function submit(e: SubmitEvent & { currentTarget: HTMLFormElement }) {
    e.preventDefault();
    const note = field(e.currentTarget, "note");
    const { urls, path, to } = props;
    void action.run(async () => {
      await post(urls.api("revert"), { path, to_seq: to, note });
      navigate(`${urls.pinned(undefined).file(path)}?done=restore`);
    });
  }
</script>

<OwnerOnly urls={props.urls}>
  <Status loaded={loaded.current}>
    {#snippet children(v)}
      <h1>Restore {title} to version {v.n}?</h1>
      <p>
        Version {v.n} is from <Moment ts={v.ts} />.
        <a href={props.urls.pinned(props.to).file(props.path)}>Read it as it was</a>.
      </p>
      <div class="panel-box">
        <p>Writes that version back as a new change by you. Nothing is erased.</p>
        {#if action.error}<div class="notice">{action.error}</div>{/if}
        <form onsubmit={submit}>
          <label>
            Note <input type="text" name="note" defaultValue={`Restore version ${v.n}`} />
          </label>
          <p class="actions">
            <Button variant="primary" type="submit" disabled={action.busy}>Restore</Button><Button href={props.urls.pinned(undefined).file(props.path)}>Cancel</Button>
          </p>
        </form>
      </div>
    {/snippet}
  </Status>
</OwnerOnly>
