<script lang="ts">
  import type { AvatarMarkProps } from "./types";

  /**
   * Someone who acts, as a small round mark (`.avatar-mark`): a person's initials on a light
   * fill, an agent's letter on ink, Tempra's own agent on the agent colour. Decorative: the name
   * beside it is the caller's to draw.
   */
  let { kind = "person", initials, size = "default" }: AvatarMarkProps = $props();
  const cls = $derived(
    [
      "avatar-mark",
      kind === "agent" ? "agent" : kind === "tempra" ? "agent tempra" : "",
      size === "small" ? "small" : "",
    ]
      .filter(Boolean)
      .join(" "),
  );
</script>

<span class={cls} aria-hidden="true">{initials}</span>
