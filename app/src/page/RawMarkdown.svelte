<script lang="ts" module>
  /** Whether the Markdown view wraps long lines, for this tab (a per-viewer convenience). */
  let wrapped = false;
</script>

<script lang="ts">
  import { Button, PillButton } from "@tempra/design/components";
  import { useLoad } from "../load.svelte.ts";
  import Status from "../Status.svelte";
  import { baseName, type Urls } from "../urls";
  import { storedFile } from "./tools";

  /**
   * The Markdown view (take 4, TEMPRA-114; TEMPRA-134; tempra-dev: app/reader, Markdown view): the
   * file as stored, frontmatter and body, in the mono with line numbers, in place of the page
   * (`?view=markdown`), with Back to page, its path, Wrap lines and Download. Each line is a span
   * whose number is a CSS counter in the gutter, so copying the text copies no numbers.
   */
  let { urls, path, hash, onBack }: { urls: Urls; path: string; hash: string; onBack(): void } =
    $props();
  const loaded = useLoad(
    () => `markdown ${urls.file(path)} ${hash}`,
    () => storedFile(urls, path),
  );
  let wrap = $state(wrapped);
</script>

<section class="raw-markdown" aria-label="Markdown"
  ><div class="raw-head"
    ><PillButton icon="previous" label="Back to page" onclick={() => onBack()} /><code class="raw-path">{path}</code
    ><Button
      aria-pressed={wrap}
      onclick={() => {
        wrapped = !wrap;
        wrap = !wrap;
      }}>Wrap lines</Button
    ><PillButton icon="download" label="Download" href={urls.raw(path)} download={baseName(path)} /></div
  ><Status loaded={loaded.current}
    >{#snippet children(text: string)}<pre class={wrap ? "raw-file wrap" : "raw-file"}>{#each text.replace(/\n$/, "").split("\n") as line, i (i)}<span class="raw-line">{line}{"\n"}</span>{/each}</pre>{/snippet}</Status
  ></section
>
