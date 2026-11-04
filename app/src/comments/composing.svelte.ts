/*
 * Whether the person is writing a comment: a draft open on a quote, or a comment or reply box
 * with text in it. A new version of the page does not swap in by itself meanwhile, so what
 * they are writing is never lost (tempra-dev: app/live; page/live.svelte.ts).
 */

const boxes = new Set<symbol>();

/** True while any comment box is in use. */
export const composing = (): boolean => boxes.size > 0;

/** Marks a comment box as in use while `active()`. */
export function useComposing(active: () => boolean) {
  $effect(() => {
    if (!active()) return;
    const me = Symbol("comment box");
    boxes.add(me);
    return () => {
      boxes.delete(me);
    };
  });
}
