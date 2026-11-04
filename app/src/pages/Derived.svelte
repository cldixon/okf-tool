<script lang="ts">
  import AtNotice from "../AtNotice.svelte";
  import { bodyHref, type FileJson } from "../page/data";
  import Reader from "../Reader.svelte";
  import { prepare } from "../reader/prepare";
  import { useLibraryTitle } from "../role.svelte.ts";
  import type { Urls } from "../urls";

  /** A synthesized file (index.md, log.md) in the reader: the file as an agent reads it. */
  let {
    urls,
    head,
    file,
  }: { urls: Urls; head: number; file: Extract<FileJson, { kind: "derived" }> } = $props();
  useLibraryTitle(
    () => urls,
    () => file.path,
  );
  const prepared = $derived(
    prepare(file.doc, { path: file.path, href: bodyHref(urls), footnote: () => null }),
  );
</script>

<AtNotice {urls} {head} current={urls.pinned(undefined).file(file.path)} /><p class="small muted"
  >Synthesized by the server. <a href={urls.raw(file.path)}>Raw</a></p
><Reader {prepared} diff={null} hideFirst={false} />
