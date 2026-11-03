<script lang="ts">
  /**
   * A mark beside each block of the body that holds open threads (TEMPRA-223; tempra-dev:
   * app/comments, In the body): a small comment glyph and the count, a button that opens the
   * Comments panel on the block's first thread. The marks sit in their own layer after the text,
   * outside the counted body (`.prose`), so `data-text` offsets and `docText` never see them;
   * each is placed through the CSSOM (`--mark-x`, `--mark-y`; CSP: no style attribute) in the
   * right gutter beside its block, or under the block's end where there is no gutter.
   */
  import { CommentMark } from "@tempra/design/components";
  import { type BlockMark, blockMarks, type Highlight, type MarkPlace, placeMark } from "./reading";

  let {
    root,
    highlights,
    prepared,
    diff,
    hideFirst,
    onOpen,
  }: {
    /** The body's text (`.prose`), where the blocks are. */
    root: HTMLElement;
    highlights: readonly Highlight[];
    /** What the body draws: when any changes, the blocks may have moved. */
    prepared: unknown;
    diff: unknown;
    hideFirst: boolean;
    onOpen(thread: string): void;
  } = $props();

  /** About a mark's width (the glyph, a gap, two digits): what the gutter must fit. */
  const WIDTH = 44;

  let layer: HTMLDivElement | undefined = $state();
  let marks = $state.raw<(Omit<BlockMark, "block"> & { key: string; place: MarkPlace })[]>([]);

  $effect(() => {
    const el = root;
    const hs = highlights;
    void [prepared, diff, hideFirst];
    const box = layer?.parentElement;
    if (!box) return;
    const measure = () => {
      const body = box.getBoundingClientRect();
      const text = el.getBoundingClientRect();
      const page = el.closest(".doc")?.getBoundingClientRect();
      const room = page ? page.right - text.right : 0;
      marks = blockMarks(el, hs).map((m, i) => ({
        first: m.first,
        count: m.count,
        key: m.block.getAttribute("data-block") ?? `b${i}`,
        place: placeMark(m.block.getBoundingClientRect(), body, text.right, room, WIDTH),
      }));
    };
    measure();
    const watch = new ResizeObserver(measure);
    watch.observe(el);
    const doc = el.closest(".doc");
    if (doc) watch.observe(doc);
    return () => watch.disconnect();
  });

  /** Places a mark through the CSSOM. */
  const at = (place: MarkPlace) => (node: HTMLElement) => {
    node.style.setProperty("--mark-x", `${place.x}px`);
    node.style.setProperty("--mark-y", `${place.y}px`);
  };
</script>

<div class="comment-marks" bind:this={layer}
  >{#each marks as m (m.key)}<CommentMark
      count={m.count}
      class={m.place.end ? "end" : undefined}
      {@attach at(m.place)}
      onclick={() => onOpen(m.first)}
    />{/each}</div
>
