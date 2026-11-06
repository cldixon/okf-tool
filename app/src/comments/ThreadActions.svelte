<script lang="ts">
  import { Button } from "@tempra/design/components";
  import { post } from "../api";
  import { useAction } from "../load.svelte.ts";
  import MentionArea from "../MentionArea.svelte";
  import { useMentionable } from "../mentions.svelte.ts";
  import type { Urls } from "../urls";
  import { useComposing } from "./composing.svelte.ts";
  import type { Placed } from "./data";

  /** Reply, Resolve, Reopen: what a person can do with an expanded thread. */
  let props: {
    urls: Urls;
    thread: Placed;
    active: boolean;
    writable: boolean;
    onActive(id: string | null): void;
    onChanged(): void;
  } = $props();
  const action = useAction();
  let reply = $state("");
  const people = useMentionable(() => props.urls);
  useComposing(() => reply.trim() !== "");
  const t = $derived(props.thread);
  function act(kind: "reply" | "resolve" | "reopen", e?: Event) {
    e?.preventDefault();
    const body = reply.trim();
    if ((kind === "reply" && !body) || action.busy) return;
    void action.run(async () => {
      const suffix = kind === "reply" ? "" : `/${kind}`;
      await post(
        props.urls.api(`comments/${encodeURIComponent(t.id)}${suffix}`),
        body ? { body } : {},
      );
      reply = "";
      // A resolved thread is no longer highlighted: nothing stays active.
      if (kind === "resolve") props.onActive(null);
      props.onChanged();
    });
  }
</script>

{#if props.writable}
  <form class="reply-form" onsubmit={(e) => act("reply", e)}
    >{#if t.status === "open"}<label class="visually-hidden" for={`reply-${t.id}`}>Reply</label><MentionArea
        id={`reply-${t.id}`}
        value={reply}
        onValue={(v) => (reply = v)}
        people={people.current}
        onSend={() => act("reply")}
        placeholder="Reply…"
      />{/if}{#if action.error}<div class="notice">{action.error}</div>{/if}<div class="actions"
      >{#if t.status === "open"}<Button disabled={action.busy} onclick={() => act("resolve")}>Resolve</Button><Button variant="primary" type="submit" disabled={action.busy || !reply.trim()}>Reply</Button>{:else}<Button disabled={action.busy} onclick={() => act("reopen")}>Reopen</Button>{/if}</div
    ></form
  >
{/if}
