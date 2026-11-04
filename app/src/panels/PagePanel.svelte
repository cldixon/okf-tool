<script lang="ts">
  import { Chip, Mark } from "@tempra/design/components";
  import Reader from "../Reader.svelte";
  import { prepare } from "../reader/prepare";
  import { localTime, relativeTime } from "../ui";
  import { bodyOptions, bylineName, type PageHost, type PagePayload, whereOf } from "./page";

  /**
   * The page panel (tempra-dev: app/page-panel): one page drawn in the chat by the app's reader,
   * read only: where it sits (after the Tempra mark, which names the source; TEMPRA-279), its title, description and byline, the body and its sources. The
   * look is @tempra/design's (panel.css, prose.css, reader.css).
   */
  let { host }: { host: PageHost } = $props();

  let page = $state.raw<PagePayload | null | undefined>(undefined);
  $effect(() => host.subscribe((p) => (page = p)));

  const prepared = $derived(page ? prepare(page.page.doc, bodyOptions(page)) : null);
  // A leading heading that repeats the title is not shown twice, as on the app's page.
  const hideFirst = $derived.by(() => {
    const first = prepared?.headings[0];
    const title = page?.page.title.trim().toLowerCase() ?? "";
    return first?.first === true && first.text.trim().toLowerCase() === title;
  });

  // A web link opens in the person's browser, through the host; the panel itself never moves.
  function follow(e: MouseEvent) {
    const a = e.target instanceof Element ? e.target.closest("a[href]") : null;
    if (!(a instanceof HTMLAnchorElement) || (a.getAttribute("href") ?? "").startsWith("#")) return;
    e.preventDefault();
    void host.openLink(a.href);
  }
</script>

{#if page === null}
  <p class="muted">This page could not be shown.</p>
{:else if !page || !prepared}
  <p class="muted">Opening the page…</p>
{:else}
  <!-- Links are followed by one listener on the page; each is still a link, reached by the keyboard. -->
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
  <article class="page-panel" onclick={follow}>
    <header class="pp-head">
      <p class="pp-where mark-lockup"><Mark small label="Tempra" />{whereOf(page)}</p>
      <h1 class="pp-title">{page.page.title}</h1>
      {#if page.page.description}<p class="pp-description">{page.page.description}</p>{/if}
      {#if page.byline || (page.page.status && page.page.status !== "stable") || page.page.stale}
        <p class="pp-byline">
          {#if page.byline}<span
              >{bylineName(page.byline)}{" · edited "}<time datetime={page.byline.at} title={localTime(page.byline.at)}
                >{relativeTime(page.byline.at)}</time
              ></span
            >{/if}{#if page.page.status && page.page.status !== "stable"}<Chip
              >{page.page.status[0]?.toUpperCase()}{page.page.status.slice(1)}</Chip
            >{/if}{#if page.page.stale}<Chip>Stale</Chip>{/if}
        </p>
      {/if}
    </header>
    <div class="doc">
      <Reader {prepared} diff={null} {hideFirst} figureView={{ title: page.page.title }} />
      {#if page.sources.length > 0}
        <section class="pp-sources prose" aria-labelledby="pp-sources">
          <h2 id="pp-sources">Sources</h2>
          <ol>
            {#each page.sources as s (s.id)}
              <li id={`src-${s.id}`}>
                {#if s.resource && /^https?:\/\//.test(s.resource)}<a href={s.resource}>{s.title ?? s.resource}</a
                  >{:else}{s.title ?? s.resource ?? s.id}{/if}
              </li>
            {/each}
          </ol>
        </section>
      {/if}
    </div>
  </article>
{/if}
