<script lang="ts">
  import { post } from "../api";
  import { useAction } from "../load.svelte.ts";
  import MentionArea from "../MentionArea.svelte";
  import { useMentionable } from "../mentions.svelte.ts";
  import { clip } from "../ui";
  import type { Urls } from "../urls";
  import { useComposing } from "./composing.svelte.ts";
  import type { Draft, Thread } from "./data";

  /**
   * A new comment: on the selected text (a draft, started from the selection toolbar, at the top
   * of the Comments panel) or on the whole page. Escape, Cancel, or leaving it empty drops it.
   */
  let props: {
    urls: Urls;
    path: string;
    draft: Draft | null;
    onDone(): void;
    onPosted(id: string): void;
  } = $props();
  const action = useAction();
  let text = $state("");
  let box: HTMLTextAreaElement | undefined = $state();
  const people = useMentionable(() => props.urls);
  useComposing(() => props.draft !== null || text.trim() !== "");
  // The box takes the focus when it opens (from the toolbar, or "Comment on the page"), and on a
  // new draft.
  $effect(() => {
    void props.draft;
    box?.focus();
  });
  function submit(e: SubmitEvent) {
    e.preventDefault();
    send();
  }
  function send() {
    const body = text.trim();
    if (!body || action.busy) return;
    const draft = props.draft;
    void action.run(async () => {
      // No path: a thread on the library itself (TEMPRA-222).
      const r = await post<{ thread: Thread }>(props.urls.api("comments"), {
        ...(props.path ? { path: props.path } : {}),
        body,
        anchor: draft ? { quote: draft.quote, from: draft.from } : null,
      });
      text = "";
      props.onDone();
      props.onPosted(r.thread.id);
    });
  }
</script>

<form class="thread open comment-form" onsubmit={submit}
  >{#if props.draft}<blockquote class="quote thread-quote">{clip(props.draft.quote, 300)}</blockquote>{/if}<label
    class="visually-hidden"
    for="new-comment">Comment</label
  ><MentionArea
    id="new-comment"
    bind:textarea={box}
    value={text}
    onValue={(v) => (text = v)}
    people={people.current}
    onSend={send}
    onkeydown={(e) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        props.onDone();
      }
    }}
    onblur={(e) => {
      // Leaving an empty draft drops it, as a click away does.
      const to = e.relatedTarget instanceof Element ? e.relatedTarget : null;
      if (!e.currentTarget.value.trim() && !to?.closest(".comment-form")) props.onDone();
    }}
    placeholder={props.draft
      ? "Comment on the selection"
      : props.path
        ? "Comment on the page"
        : "Comment on the library"}
  />{#if action.error}<div class="notice">{action.error}</div>{/if}<div class="actions"
    ><button type="button" class="ghost" onclick={() => props.onDone()}>Cancel</button
    ><button class="primary" type="submit" disabled={action.busy || !text.trim()}>Comment</button></div
  ></form
>
