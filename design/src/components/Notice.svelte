<script lang="ts">
  import type { NoticeProps } from "./types";

  /** A message about the page (`.notice`): an error, said at once (`alert`), or a done (`ok`). */
  let { tone = "error", children }: NoticeProps = $props();
</script>

<div class={tone === "ok" ? "notice ok" : "notice"} role={tone === "ok" ? "status" : "alert"}>
  {@render children()}
</div>
