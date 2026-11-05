<script lang="ts">
  import { Button } from "@tempra/design/components";
  import CopyField from "../CopyField.svelte";

  /**
   * How to connect each kind of client; `slug` names the library when the page is about one, and
   * `library` (owner/slug) picks it in the token form.
   */
  let props: {
    slug?: string;
    library?: string;
    /** On the Agents page, New token opens its dialog there. */
    onNewToken?: () => void;
    /** Its headings' level: 2 on a page of its own, 3 inside a section (Settings' Connect). */
    level?: 2 | 3;
  } = $props();
  const heading = $derived(`h${props.level ?? 2}`);
  const mcp = `${location.origin}/mcp`;
</script>

<svelte:element this={heading}>claude.ai</svelte:element>
<p>
  Add a custom connector with this URL. When asked, {props.slug
    ? `choose All libraries, or select ${props.slug}`
    : "choose All libraries, or select the ones it may use"}.
</p>
<p>
  <CopyField value={mcp} label="the MCP URL" />
</p>
<svelte:element this={heading}>Claude Code</svelte:element>
<p>
  <CopyField value={`claude mcp add --transport http tempra ${mcp}`} label="the Claude Code command" />
</p>
<p>Then run /mcp in Claude Code to sign in.</p>
<svelte:element this={heading}>Other clients and scripts</svelte:element>
<p>
  {#if props.onNewToken}
    <Button onclick={props.onNewToken}>New token</Button>
  {:else}
    <a
      href={props.library
        ? `/agents?new=token&library=${encodeURIComponent(props.library)}`
        : "/agents?new=token"}>New token</a
    >
  {/if}
</p>
