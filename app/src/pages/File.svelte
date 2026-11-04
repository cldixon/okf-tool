<script lang="ts">
  import { useThreads } from "../comments/data.svelte.ts";
  import { useLoad } from "../load.svelte.ts";
  import PageColumn from "../PageColumn.svelte";
  import { type FileData, fileKey, isPagePath, loadFile } from "../page/data";
  import LiveChange from "../page/LiveChange.svelte";
  import { useLiveFile } from "../page/live.svelte.ts";
  import PageView from "../page/PageView.svelte";
  import { type Compare, navigate } from "../router";
  import Status from "../Status.svelte";
  import { useScrollToHash } from "../ui.svelte.ts";
  import { baseName, dirOf, type Urls } from "../urls";
  import Attachment from "./Attachment.svelte";
  import Derived from "./Derived.svelte";
  import { DONE } from "./file";
  import NotFound from "./NotFound.svelte";

  /**
   * A file's page: a page in its own layout (page/PageView), an attachment (board 28), or
   * a synthesized file (log.md) in a page column; Not found (board 32) for a path with nothing
   * there. A folder's index.md is the folder's page.
   */
  let props: {
    urls: Urls;
    path: string;
    done: string | null;
    actor: string;
    compare: Compare | null;
  } = $props();
  const loaded = useLoad(
    () => fileKey(props.urls, props.path),
    () => loadFile(props.urls, props.path),
  );
  // A page's comment threads load beside it, and reload on their own (comments are not
  // content: a new comment never redraws the body).
  const threads = useThreads(
    () => props.urls,
    () => (isPagePath(props.path) ? props.path : null),
  );
  // index.md is the directory's own page.
  $effect(() => {
    if (baseName(props.path) === "index.md") {
      navigate(props.urls.tree(dirOf(props.path)), { replace: true });
    }
  });
  useScrollToHash(() => loaded.state === "ready");
  const notice = $derived(props.done ? DONE[props.done]?.(props.actor) : undefined);
  const shown = $derived<FileData | null>(loaded.data ?? null);
  const live = useLiveFile(
    () => props.urls,
    () => shown,
    () => props.actor,
    () => loaded.reload(),
    () => threads.reload(),
  );
  const pageData = $derived(shown?.extra);
  const attachment = $derived(shown?.file.kind === "attachment" ? shown.file : null);
</script>

{#if shown && pageData}
  <PageView
    urls={props.urls}
    data={pageData}
    head={shown.head}
    compare={props.compare}
    threads={threads.data?.threads ?? null}
    threadsError={threads.error?.message ?? null}
    {notice}
    live={live.current}
    onCommented={() => threads.reload()}
    onVerified={() => loaded.reload()}
  />
{:else if loaded.error?.status === 404}
  <NotFound urls={props.urls} path={props.path} />
{:else}
  <PageColumn wide={attachment !== null}
    >{#if notice}<div class="notice">{notice}</div>{/if}{#if live.current}<LiveChange
        urls={props.urls}
        live={live.current}
        notice
      />{/if}<Status loaded={loaded.current}
      >{#snippet children(d: FileData)}{#if d.file.kind === "attachment"}<Attachment
            urls={props.urls}
            file={d.file}
            head={d.head}
          />{:else if d.file.kind === "derived"}<Derived urls={props.urls} file={d.file} head={d.head} />{/if}{/snippet}</Status
    ></PageColumn
  >
{/if}
