<script lang="ts">
  import { ChangeRow } from "@tempra/design/components";
  import AgentName from "./AgentName.svelte";
  import Avatar from "./Avatar.svelte";
  import type { LiveWrite } from "./activity";
  import type { ActorView } from "./agents";
  import type { Urls } from "./urls";

  /**
   * The live entry at the top of the Summary: an agent writing now ("Claude Code is editing
   * Reader"), with the pulsing dot, while its writes keep arriving.
   */
  let {
    write: w,
    urls,
    actor,
    title,
  }: { write: LiveWrite; urls: Urls; actor: ActorView; title: string } = $props();
</script>

<ChangeRow live aria-live="polite">
  {#snippet lead()}<Avatar name={actor.mark} fullName={actor.fullName} agent={actor.agent} tempra={actor.tempra} />{/snippet}
  <AgentName who={actor} /> is editing <a href={urls.file(w.path)}>{title}</a>
  {#snippet when()}<span class="entry-now"><span class="change-dot live" aria-hidden="true"></span>now</span>{/snippet}
</ChangeRow>
