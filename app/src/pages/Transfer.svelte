<script lang="ts">
  import { Segmented } from "@tempra/design/components";
  import { api, field, post } from "../api";
  import { useAction, useLoad } from "../load.svelte.ts";
  import { useRole } from "../role.svelte.ts";
  import Status from "../Status.svelte";
  import { plural } from "../ui";
  import type { Urls } from "../urls";
  import { exportLabel, forOwner, type Nightly } from "./manage";

  /**
   * The Settings page's Import & export section (the owner's alone, Settings.svelte): export a
   * bundle, import one as a single change, and the nightly exports.
   */
  let { urls }: { urls: Urls } = $props();
  const role = useRole(() => urls);
  const loaded = useLoad(
    () => `transfer ${urls.base} ${role.current}`,
    () =>
      forOwner(role.current, async () => {
        const nightly = await api<{ exports: Nightly[] }>(urls.api("exports"));
        return { nightly: nightly.exports };
      }),
  );
  const action = useAction();
  /** What the last action did: a line, or an import with a link to it in Activity. */
  let result = $state.raw<string | { files: number; name: string } | null>(null);
  /** The download's format: the files alone, or an OKF bundle (`?format=okf`). */
  let format = $state<"plain" | "okf">("plain");
  const formats = [
    { value: "plain", label: "Files" },
    { value: "okf", label: "OKF bundle" },
  ] as const;

  function upload(e: SubmitEvent & { currentTarget: HTMLFormElement }) {
    e.preventDefault();
    const form = e.currentTarget;
    const file = (form.elements.namedItem("bundle") as HTMLInputElement).files?.[0];
    const strip = Number(field(form, "strip")) || 0;
    const note = field(form, "note");
    void action.run(async () => {
      if (!file) throw new Error("Choose a .tar or .tar.gz file to import.");
      result = null;
      const res = await api<{ files: number; seq: number }>(
        urls.api("import", { strip, source: `upload:${file.name}` }),
        {
          method: "POST",
          body: file,
          headers: {
            "Content-Type": "application/x-tar",
            "X-Note": encodeURIComponent(note || `Import ${file.name}`),
          },
        },
      );
      result = { files: res.files, name: file.name };
      form.reset();
      loaded.reload();
    });
  }
  const exportNow = () =>
    action.run(async () => {
      const res = await post<{ export: string | null }>(urls.api("maintain"));
      result = res.export
        ? "Export saved. It is listed under Nightly exports."
        : "Nothing changed since the last export, so none was saved.";
      loaded.reload();
    });
</script>

{#if result}
  <div class="notice ok">
    {#if typeof result === "string"}{result}{:else}Imported {plural(result.files, "file")} from {result.name} as
      one change. <a href={urls.activity({ view: "events" })}>See it in Activity</a>.{/if}
  </div>
{/if}
{#if action.error}<div class="notice">{action.error}</div>{/if}
<div class="panel-box">
  <h3>Export</h3>
  <p>Every page and file as they are now, as one .tar bundle.</p>
  <!-- A plain link: the browser downloads the signed export link it redirects to. -->
  <p><Segmented label="Format" options={formats} bind:value={format} /></p>
  <a class="button primary" href={urls.exportTar(undefined, format === "okf" ? "okf" : undefined)}
    >Download .tar</a
  >
</div>
<div class="panel-box">
  <h3>Import</h3>
  <p>A .tar or .tar.gz bundle, as one change you can revert.</p>
  <form onsubmit={upload}>
    <p>
      <input
        type="file"
        name="bundle"
        aria-label="Bundle"
        accept=".tar,.tgz,.gz,application/x-tar,application/gzip"
        required
      />
    </p>
    <p>
      <label class="small">
        Leading folders to drop
        <input type="number" name="strip" min={0} max={10} defaultValue={0} />
      </label>
    </p>
    <p>
      <input type="text" name="note" aria-label="Note" placeholder="Note (optional)" />
    </p>
    <button class="primary" type="submit" disabled={action.busy}>Import</button>
  </form>
</div>
<Status loaded={loaded.current}>
  {#snippet children({ nightly })}
    <div class="panel-box">
      <h3>Nightly exports</h3>
      {#if nightly.length === 0}
        <p>None yet.</p>
      {:else}
        <div class="table-wrap">
          <table class="list">
            <thead class="visually-hidden">
              <tr>
                <th>Export</th>
                <th>Files</th>
                <th>Downloads</th>
              </tr>
            </thead>
            <tbody>
              {#each nightly as n (n.date)}
                <tr>
                  <td>
                    <strong>{exportLabel(n.date)}</strong>
                  </td>
                  <td class="muted small">{n.files !== null ? plural(n.files, "file") : ""}</td>
                  <td>
                    <a href={urls.nightly(n.date, "bundle.tar")}>Bundle</a> ·
                    <a href={urls.nightly(n.date, "ledger.jsonl")}>History</a>
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      {/if}
      <button type="button" disabled={action.busy} onclick={() => void exportNow()}>Export now</button>
    </div>
  {/snippet}
</Status>
