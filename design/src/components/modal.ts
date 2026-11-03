/**
 * Opens and closes a `<dialog>` as a modal with `open()` (a Svelte attachment); on opening,
 * the element marked `data-autofocus` takes the focus, if there is one.
 */
export function modal(open: () => boolean) {
  return (d: HTMLDialogElement) => {
    if (open() && !d.open && typeof d.showModal === "function") {
      d.showModal();
      d.querySelector<HTMLElement>("[data-autofocus]")?.focus();
    } else if (!open() && d.open) d.close();
  };
}
