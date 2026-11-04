<script lang="ts">
  import { Icon, Menu } from "@tempra/design/components";
  import { useCopy } from "../ui.svelte.ts";
  import { baseName, type Urls } from "../urls";
  import type { PanelName } from "./panel";
  import { storedFile } from "./tools";

  /**
   * ⋯: Copy page, the panels (Comments with its open count, TEMPRA-223; History, Properties), the
   * Markdown view, the page's link and file.
   */
  let props: {
    urls: Urls;
    path: string;
    /** Open threads on the page, shown beside Comments. */
    openCount: number;
    panel: PanelName | null;
    markdown: boolean;
    onPanel(name: PanelName): void;
    onMarkdown(on: boolean): void;
  } = $props();
  const link = useCopy();
  const page = useCopy();
</script>

<Menu name="More" title="More" buttonClass="icon-button" align="end"
  >{#snippet label()}<Icon name="more" />{/snippet}<!-- Copy page heads ⋯ (and stays open to say it copied). --><button
    type="button"
    class="menu-item"
    data-stay="true"
    onclick={() => page.copy(() => storedFile(props.urls, props.path))}
    ><Icon name="copy" /> <span aria-live="polite">{page.state === "copied" ? "Copied" : page.state === "failed" ? "Could not copy" : "Copy page"}</span></button
  ><hr /><button type="button" class="menu-item" aria-pressed={props.panel === "comments"} onclick={() => props.onPanel("comments")}
    ><Icon name="comments" /> Comments{#if props.openCount > 0}<span class="menu-count">{props.openCount} open</span>{/if}</button
  ><button type="button" class="menu-item" aria-pressed={props.panel === "history"} onclick={() => props.onPanel("history")}
    ><Icon name="history" /> History</button
  ><button type="button" class="menu-item" aria-pressed={props.panel === "properties"} onclick={() => props.onPanel("properties")}
    ><Icon name="properties" /> Properties</button
  ><button type="button" class="menu-item" aria-pressed={props.markdown} onclick={() => props.onMarkdown(!props.markdown)}
    ><Icon name="markdown" /> {props.markdown ? "Back to page" : "View Markdown"}</button
  ><hr /><button
    type="button"
    class="menu-item"
    onclick={() => link.copy(new URL(props.urls.pinned(props.urls.at).file(props.path), location.href).href)}
    ><Icon name="link" /> Copy link</button
  ><a class="menu-item" href={props.urls.raw(props.path)} download={baseName(props.path)}><Icon name="download" /> Download <span class="menu-hint">.md</span></a
  ></Menu
>
