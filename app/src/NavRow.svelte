<script lang="ts">
  import { type Glyph, Icon, Tile } from "@tempra/design/components";
  import { tileLetter } from "./ui";

  /**
   * A row of the sidebar: a glyph (or a tile) and a name.
   */
  let props: {
    href: string;
    current?: boolean;
    icon?: Glyph;
    tile?: { name: string; shared?: boolean };
    label: string;
    className?: string;
  } = $props();
</script>

<a
  class={props.className ? `nav-row ${props.className}` : "nav-row"}
  href={props.href}
  aria-current={props.current ? "page" : undefined}
  >{#if props.icon}<Icon name={props.icon} />{/if}{#if props.tile}<Tile
      letter={tileLetter(props.tile.name)}
      size="small"
      shared={props.tile.shared}
    />{/if}<span class="nav-label">{props.label}</span></a
>
