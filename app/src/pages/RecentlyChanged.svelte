<script lang="ts">
  import { ChangeRow } from "@tempra/design/components";
  import Avatar from "../Avatar.svelte";
  import type { ActedBy, ActorView } from "../agents";
  import Moment from "../Moment.svelte";
  import { dirOf, folderName, type Urls } from "../urls";
  import type { Changed } from "./home";

  /**
   * Recently changed: the last few pages edited, each a ChangeRow as Activity's are (TEMPRA-288):
   * who, the page, its folder and who for, when; absent when none.
   */
  let {
    urls,
    changed,
    view,
  }: { urls: Urls; changed: Changed[]; view(actor: string, by: ActedBy | null): ActorView } =
    $props();
</script>

{#if changed.length > 0}
  <section class="home-section" aria-labelledby="home-recent">
    <div class="view-section-head">
      <h2 id="home-recent" class="view-section-title">Recently changed</h2>
    </div>
    <ul class="home-recent">
      {#each changed as c (c.path)}
        {@const who = view(c.actor, c.by)}
        {@const folder = dirOf(c.path)}
        <li>
          <ChangeRow>
            {#snippet lead()}<Avatar name={who.mark} fullName={who.fullName} agent={who.agent} tempra={who.tempra} />{/snippet}
            <a class="home-recent-title" href={urls.file(c.path)}>{c.title}</a>
            {#snippet detail()}<span class="change-row-meta">{#if folder}{`${folderName(folder)} · `}{/if}{who.name}{who.for ? ` for ${who.for}` : ""}</span>{/snippet}
            {#snippet when()}<Moment ts={c.ts} />{/snippet}
          </ChangeRow>
        </li>
      {/each}
    </ul>
  </section>
{/if}
