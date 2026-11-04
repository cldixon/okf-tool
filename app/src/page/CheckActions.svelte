<script lang="ts">
  import { Icon } from "@tempra/design/components";
  import { day, plural } from "../ui";
  import type { Urls } from "../urls";
  import type { Namer } from "./byline";
  import { checker } from "./checked";
  import { useCheck } from "./checked.svelte.ts";
  import type { Standing } from "./data";

  /*
   * A page's Check items in its page actions' menu (TEMPRA-172, after Comment): Review changes,
   * Mark as checked, or a quiet line saying who checked it, by the page's state; of the latest
   * version only.
   */
  let props: {
    urls: Urls;
    path: string;
    standing: Standing;
    name: Namer;
    /** The latest version is on screen (checking is of the latest only). */
    current: boolean;
    /** Review mode is on: its bar holds Mark as checked and Done. */
    reviewing: boolean;
    /** A write member, who may mark the page as checked. */
    mayVerify: boolean;
    /** The page was marked as checked: its history is read again. */
    onVerified(): void;
  } = $props();

  const check = useCheck(
    () => props.urls,
    () => props.path,
    () => props.onVerified(),
  );
  const failed = $derived(check.error !== null);
  const s = $derived(props.standing);
  const changed = $derived(props.current && s.verified !== null && s.since > 0);
  const who = $derived(checker(s, props.name));
</script>

{#if props.current && !props.reviewing && changed}<a class="menu-item" href={props.urls.review(props.path)}
    ><Icon name="review" /> Review changes<span class="menu-count">{plural(s.since, "change")}</span></a
  >{/if}{#if props.current && !s.verified && props.mayVerify}<button type="button" class="menu-item" data-stay={failed || undefined} onclick={() => check.check()}
    ><Icon name="check" /> {failed ? "Could not mark as checked" : "Mark as checked"}</button
  >{/if}{#if props.current && s.verified && s.since === 0 && who}<p class="menu-line">Checked by {who}, {day(s.verified.event.ts)}</p>{/if}
