<script lang="ts">
  import { docText } from "@tempra/editor";
  import Note from "../reader/Note.svelte";
  import type { Footnote, Prepared } from "../reader/prepare";
  import { anchorId } from "../ui";
  import type { Urls } from "../urls";
  import type { JsonObject, Sources as SourcesData } from "./data";

  /**
   * The concept's sources as a section at the end of the body (take 3; tempra-dev: app/reader,
   * Sources), numbered as the footnote markers and their cards number them, then any footnotes that
   * cite no source. Not part of the document's text: it sits after the reader, outside it.
   */
  let props: {
    urls: Urls;
    data: SourcesData;
    prepared: Prepared;
    /** Each footnote label's number, as the body's markers show it. */
    numbers: Map<string, number>;
  } = $props();

  /** A footnote definition's text, for comparing with a source's title. */
  function plain(f: Footnote): string {
    return docText({ type: "root", children: f.node.children }).text.trim();
  }

  const footnotes = $derived(props.prepared.footnotes);
  const items = $derived.by(() => {
    const used = new Set<string>();
    const list = props.data.sources.map((s, i) => {
      const id = typeof s.id === "string" ? s.id : null;
      if (id) used.add(id);
      const name = typeof s.title === "string" ? s.title : (id ?? "Source");
      const resource = typeof s.resource === "string" ? s.resource : null;
      const internal = (s.internal ?? null) as JsonObject | null;
      // People's words only (TEMPRA-131): no paths, trust tiers or citation counts.
      const meta: string[] = [];
      let href: string | null = null;
      let external = false;
      if (internal?.broken) {
        meta.push("missing");
      } else if (internal && typeof internal.path === "string") {
        href = props.urls.file(internal.path);
        meta.push("in this library");
        if (internal.stale) meta.push("stale");
        if (internal.status && internal.status !== "stable") meta.push(String(internal.status));
      } else if (resource && /^https?:\/\//i.test(resource)) {
        href = resource;
        external = true;
        meta.push("external");
      } else if (resource) meta.push(resource);
      // The footnote's own text, unless it only repeats the source's title.
      const note = id ? footnotes.find((f) => f.label === id) : undefined;
      const def = note && plain(note) !== name.trim() ? note : undefined;
      return { key: id ?? String(i), n: i + 1, id, name, href, external, meta, def };
    });
    return { list, used };
  });
  const others = $derived(footnotes.filter((f) => !items.used.has(f.label)));
  const shown = $derived(
    items.list.length > 0 || others.length > 0 || props.data.unmatched_footnotes.length > 0,
  );
</script>

<!-- A footnote definition, drawn as the body draws it. -->
{#snippet footnoteNote(f: Footnote)}<div class="small note"><Note prepared={props.prepared} nodes={f.node.children} /></div>{/snippet}
{#if shown}
  <section id="doc-sources" class="doc-sources" aria-labelledby="doc-sources-title"
    ><h2 id="doc-sources-title">Sources</h2
    >{#if items.list.length > 0}<ol class="sources">
        {#each items.list as item (item.key)}<li id={item.id ? anchorId("src", item.id) : undefined}
            ><span class="num">{item.n}</span><span
              >{#if item.href === null}<span>{item.name}</span>{:else if item.external}<a href={item.href} rel="noopener noreferrer nofollow">{item.name}</a>{:else}<a href={item.href}>{item.name}</a>{/if}<span class="meta">{item.meta.join(" · ")}</span
              >{#if item.def}<span class="meta">{@render footnoteNote(item.def)}</span>{/if}</span
            ></li
          >{/each}
      </ol>{/if}{#if others.length > 0}<h3>Notes</h3><ul class="sources">
        {#each others as f (f.label)}<li id={anchorId("fn", f.label)}><span class="num">{props.numbers.get(f.label) ?? f.label}</span>{@render footnoteNote(f)}</li>{/each}
      </ul>{/if}{#if props.data.unmatched_footnotes.length > 0}<p class="small warn">No source for {props.data.unmatched_footnotes.map((l) => `[^${l}]`).join(", ")}</p>{/if}</section
  >
{/if}
