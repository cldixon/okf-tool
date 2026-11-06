<script lang="ts">
  import { Icon, IconButton, SplitButton } from "@tempra/design/components";
  import { useCopy } from "../ui.svelte.ts";
  import { baseName, type Urls } from "../urls";
  import type { PanelName } from "./panel";
  import { storedFile } from "./tools";

  /**
   * A page's tools (TEMPRA-283; tempra-dev: decisions/page-tools-in-the-corner): one row of round
   * outlined buttons in the page's top-right corner, or under the byline where there is no column
   * (the stylesheet's call: the page draws it in both places). Comments with its open count, Page
   * info with the agent dot while a newer version waits, and Copy page with a ⌄ for View Markdown
   * and Download .md. The open panel's button shows pressed; pressing it again closes it. Copy page
   * keeps its glyph (TEMPRA-312): a press, then a "Copied" tip under it for a moment ("Couldn't
   * copy" if it could not), said in a polite live region too, as CopyField does.
   */
  let props: {
    urls: Urls;
    path: string;
    /** Open threads on the page, beside Comments. */
    openCount: number;
    panel: PanelName | null;
    /** A newer version waits (someone else's write on the feed). */
    newer: boolean;
    markdown: boolean;
    onPanel(name: PanelName): void;
    onMarkdown(on: boolean): void;
    /** Where this row is: the right column's corner, or the head under the byline. */
    place: "side" | "head";
  } = $props();
  const page = useCopy();
  const comments = $derived(props.openCount > 0 ? `Comments, ${props.openCount} open` : "Comments");
</script>

<div class={`page-tools page-tools-${props.place}`} role="group" aria-label="Page tools"
  ><IconButton
    variant="outlined"
    touch
    icon="comments"
    label={comments}
    title="Comments"
    count={props.openCount}
    pressed={props.panel === "comments"}
    data-panel="comments"
    onclick={() => props.onPanel("comments")}
  /><IconButton
    variant="outlined"
    touch
    icon="info"
    label={props.newer ? "Page info, a newer version" : "Page info"}
    title={props.newer ? "Page info · a newer version" : "Page info"}
    dot={props.newer}
    pressed={props.panel === "info"}
    data-panel="info"
    onclick={() => props.onPanel("info")}
  /><SplitButton
    touch
    icon="copy"
    label="Copy page"
    tip={page.tip}
    menuLabel="More copy options"
    onclick={() => page.copy(() => storedFile(props.urls, props.path))}
    >{#snippet children()}<button type="button" class="menu-item" aria-pressed={props.markdown} onclick={() => props.onMarkdown(!props.markdown)}
        ><Icon name="markdown" /> {props.markdown ? "Back to page" : "View Markdown"}</button
      ><a class="menu-item" href={props.urls.raw(props.path)} download={baseName(props.path)}><Icon name="download" /> Download <span class="menu-hint">.md</span></a
      >{/snippet}</SplitButton
  ></div
>
