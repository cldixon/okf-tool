<script lang="ts">
  import { actorText } from "../agents";
  import Moment from "../Moment.svelte";
  import type { Namer } from "./byline";
  import { actedBy, type Version } from "./data";

  /** "Changes in v3 · note · who · when". */
  let { version, name, lead }: { version: Version; name: Namer; lead: string } = $props();
  const by = $derived(name(version.event.actor, actedBy(version.event)));
  const note = $derived(
    typeof version.event.meta?.note === "string" ? version.event.meta.note : "",
  );
</script>

<strong class="review-lead">{lead}</strong>{#if note}<span class="review-note">{` · ${note}`}</span>{/if}<span class="muted">{` · ${actorText(by)} · `}<Moment ts={version.event.ts} /></span>
