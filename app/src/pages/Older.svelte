<script lang="ts">
  import { Button } from "@tempra/design/components";
  import type { Snippet } from "svelte";
  import { type LedgerRequest, REQUESTS_PAGE, type RequestPage } from "../activity";
  import { api } from "../api";
  import { useOlder } from "../paging.svelte.ts";
  import type { Urls } from "../urls";

  /**
   * The first page and the older ones "Older" pages back to, as one list of requests (both views
   * draw from it). The first page reloads as agents write; the older pages are kept across that
   * (`useOlder`). Keyed by the server's filters (`{#key}` in Activity), so changing them starts
   * afresh.
   */
  let {
    urls,
    prefix,
    actor,
    first,
    children,
  }: {
    urls: Urls;
    prefix: string;
    actor: string;
    first: RequestPage;
    /** The requests loaded so far, and whether there are older ones to page to. */
    children: Snippet<[LedgerRequest[], boolean]>;
  } = $props();

  const page = $derived({ items: first.requests, next: first.next });
  const older = useOlder(
    () => page,
    (r) => r.request_id,
    (before: number) =>
      api<RequestPage>(
        urls.api("requests", {
          prefix: prefix || undefined,
          actor: actor || undefined,
          before,
          limit: REQUESTS_PAGE,
        }),
      ).then((p) => ({ items: p.requests, next: p.next })),
  );
</script>

{@render children(older.items, older.next !== null)}
{#if older.next !== null}
  <p class="view-more">
    <Button onclick={older.loadOlder} disabled={older.paging}>{older.paging ? "Loading…" : "Older"}</Button>
  </p>
{/if}
