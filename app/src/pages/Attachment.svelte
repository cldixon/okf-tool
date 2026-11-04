<script lang="ts">
  import { Icon } from "@tempra/design/components";
  import AgentName from "../AgentName.svelte";
  import AtNotice from "../AtNotice.svelte";
  import { useActors } from "../agents.svelte.ts";
  import { api } from "../api";
  import { useTitleOf } from "../frame.svelte.ts";
  import { attachmentSource, mediaKind } from "../images";
  import { useLoad } from "../load.svelte.ts";
  import Moment from "../Moment.svelte";
  import { type FileJson, type HistoryEvent, isPagePath, type Links } from "../page/data";
  import Player from "../reader/Player.svelte";
  import { useLibraryTitle } from "../role.svelte.ts";
  import { useCopy } from "../ui.svelte.ts";
  import { baseName, enc, type Urls } from "../urls";
  import AttachmentImage from "./AttachmentImage.svelte";
  import { describedAs, figureUse, type Use, versionsOf } from "./attachment";
  import FileHistory from "./FileHistory.svelte";
  import { type AttachmentFile, sizeFact, typeName, USES_READ } from "./file";
  import SourceFact from "./SourceFact.svelte";
  import UsedIn from "./UsedIn.svelte";

  /**
   * An attachment (board 28; TEMPRA-170, tempra-dev: app/media, The image's page): the image (or a
   * file icon) large on a dark frame; beside it the filename and what it shows, Download and Copy
   * link, then Type, Size, Added, Source, Credit, Licence, Poster for (a video's poster, TEMPRA-182)
   * and Used in (each page and the figures it appears as); under them File history, every version
   * with its own Download. A video plays in place with its poster when one is beside it.
   */
  let { urls, head, file }: { urls: Urls; head: number; file: AttachmentFile } = $props();
  useLibraryTitle(
    () => urls,
    () => baseName(file.path),
  );
  const actors = useActors(() => urls);
  const extra = useLoad(
    () => `attachment ${urls.base} ${file.path} ${file.seq}`,
    async () => {
      const p = enc(file.path);
      const [links, history] = await Promise.all([
        api<Links>(urls.api(`links/${p}`, { at: urls.at })),
        api<{ events: HistoryEvent[] }>(urls.api(`history/${p}`)),
      ]);
      return { links, history: history.events };
    },
  );
  const usedIn = $derived(
    extra.data ? [...new Set(extra.data.links.inbound.map((l) => l.path))] : null,
  );
  // The pages that use it, read for the figures it appears as and the sources citing it; a page
  // that fails to load just says less.
  const pages = $derived(usedIn?.filter(isPagePath).slice(0, USES_READ).join("\n") ?? null);
  const uses = useLoad(
    () => `attachment uses ${urls.base} ${file.path} ${file.seq} ${pages}`,
    async () => {
      if (pages === null) return null;
      const read = await Promise.all(
        pages
          .split("\n")
          .filter(Boolean)
          .map((p) =>
            api<FileJson>(urls.api(`files/${enc(p)}`, { at: urls.at })).then(
              (f) => (f.kind === "page" ? figureUse(file.path, f, file.source) : null),
              () => null,
            ),
          ),
      );
      return read.filter((u): u is Use => u !== null);
    },
  );
  const usesShown = $derived(uses.data ?? null);
  // The pages that use it by title, as the frame's outline names them.
  const titleOf = useTitleOf();
  const titles = $derived(new Map((usedIn ?? []).map((p) => [p, titleOf.of(p)])));
  let natural = $state<{ w: number; h: number } | null>(null);
  let broken = $state(false);
  const copied = useCopy();
  const image = $derived(file.media?.startsWith("image/") && !broken);
  const playable = $derived.by(() => {
    const kind = mediaKind(file.media);
    return kind === "video" || kind === "audio" ? kind : null;
  });
  const href = $derived(urls.download(file.path));
  const versions = $derived(
    extra.data ? versionsOf(extra.data.history, urls.at ?? Number.MAX_SAFE_INTEGER) : null,
  );
  const added = $derived(versions?.at(-1));
  const current = $derived(versions?.find((v) => v.current) ?? null);
  const name = actors.view;
  const described = $derived(describedAs(file.description, usesShown));
</script>

<div class="attachment"
  ><AtNotice {urls} {head} current={urls.pinned(undefined).file(file.path)} /><div class="attachment-frame"
    ><!-- Video and audio play in place (TEMPRA-164). -->{#if playable && !broken}<Player
        kind={playable}
        source={attachmentSource(urls, file, file.path)}
        name={described?.text ?? baseName(file.path)}
        onError={() => (broken = true)}
      />{:else if image}<AttachmentImage
        {urls}
        {file}
        alt={described?.text}
        onLoad={(img) => (natural = { w: img.naturalWidth, h: img.naturalHeight })}
        onError={() => (broken = true)}
      />{:else}<span class="attachment-icon"><Icon name={broken ? "broken" : "file"} size={48} /></span>{/if}</div
  ><aside class="attachment-side" aria-label="About this file"
    ><div class="attachment-head"
      ><h1 class="attachment-name">{baseName(file.path)}</h1
      >{#if described}<p class="attachment-description"
          >{described.text}{#if described.fromAlt}<span class="muted">{" (the alt text where it is used)"}</span>{/if}</p
        >{/if}</div
    ><p class="attachment-actions"
      ><a class="button primary" {href} download={baseName(file.path)}><Icon name="download" /> Download</a
      ><button
        type="button"
        onclick={() => void copied.copy(new URL(urls.pinned(undefined).file(file.path), location.href).href)}
        >{copied.state === "copied" ? "Copied" : copied.state === "failed" ? "Couldn't copy" : "Copy link"}</button
      ></p
    ><dl class="attachment-facts"
      ><div><dt>Type</dt><dd>{typeName(file.media, file.path)}</dd></div
      ><div><dt>Size</dt><dd>{sizeFact(file, natural)}</dd></div
      >{#if added}<div
          ><dt>Added</dt><dd
            ><div><AgentName who={name(added.actor, added.by)} /></div
            ><div class="muted"><Moment ts={added.ts} /></div></dd
          ></div
        >{/if}<div
        ><dt>Source</dt><dd
          ><SourceFact {urls} source={file.source} suppliedBy={file.supplied_by} madeFrom={file.made_from} version={current} uses={usesShown} {titles} {name} /></dd
        ></div
      >{#if file.credit}<div><dt>Credit</dt><dd>{file.credit}</dd></div>{/if}{#if file.licence}<div
          ><dt>Licence</dt><dd>{file.licence}</dd></div
        >{/if}{#if file.poster_for}<div
          ><dt>Poster for</dt><dd><a href={urls.file(file.poster_for)}>{baseName(file.poster_for)}</a></dd></div
        >{/if}<div
        ><dt>Used in</dt><dd><UsedIn {urls} paths={usedIn} uses={usesShown} {titles} /></dd></div
      ></dl
    ></aside
  >{#if versions && versions.length > 0}<FileHistory {urls} path={file.path} {versions} {name} />{/if}</div
>
