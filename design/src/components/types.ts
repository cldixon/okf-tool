/**
 * The components' props (TEMPRA-252), by the shared spec's names. Each component takes its props
 * from here, and index.ts types its export with them, so a consumer outside this package (the
 * app, whose svelte-check sees these .svelte files only as modules) checks its props against them.
 * Where a component takes "other attributes", they go to its element: a class beside its own,
 * `aria-*`, `data-*`, `title`, an attachment.
 */
import type { Snippet } from "svelte";
import type { Glyph } from "./icons";

export type { Glyph };

/** Attributes passed through to the component's element. */
type Rest = { class?: string; [attr: string]: unknown };

export type IconProps = { name: Glyph; size?: number };

export type ButtonProps = {
  variant?: "default" | "primary" | "ghost";
  type?: "button" | "submit" | "reset";
  /** A link drawn as a button (`a.button`); `type` and `disabled` are a button's only. */
  href?: string;
  disabled?: boolean;
  onclick?: (e: MouseEvent) => void;
  children: Snippet;
} & Rest;

export type PillButtonProps = {
  icon?: Glyph;
  label: string;
  href?: string;
  onclick?: (e: MouseEvent) => void;
} & Rest;

export type ToolPillProps = {
  label: string;
  href?: string;
  onclick?: (e: MouseEvent) => void;
} & Rest;

export type IconButtonProps = {
  icon: Glyph;
  /** The accessible name, and the tooltip unless `title` says otherwise. */
  label: string;
  pressed?: boolean;
  /** A 44px area on a phone. */
  touch?: boolean;
  /** The outlined look of a page's corner tools (TEMPRA-283): a ring, 36px, the glyph in ink. */
  variant?: "plain" | "outlined";
  /** A number shown beside the glyph (open comments); the button grows into a pill for it. */
  count?: number | null;
  /** The agent dot on its corner (a newer version waits). */
  dot?: boolean;
  onclick?: (e: MouseEvent) => void;
  title?: string;
} & Rest;

export type SplitButtonProps = {
  /** The main part's glyph. */
  icon: Glyph;
  /** The main part's accessible name and tooltip ("Copy page", then "Copied" a moment). */
  label: string;
  onclick?: (e: MouseEvent) => void;
  /** The ⌄ part's accessible name ("More copy options"). */
  menuLabel: string;
  /** A 44px area on a phone. */
  touch?: boolean;
  /** The ⌄ menu's choices; handed a way to close the menu. */
  children: Snippet<[() => void]>;
} & Rest;

export type SearchButtonProps = {
  /** The shortcut told in the title ("Ctrl K", "⌘K"). */
  shortcut: string;
  onclick?: (e: MouseEvent) => void;
};

export type FieldProps = { label: string; hint?: string; children: Snippet };

export type TextInputProps = {
  value?: string;
  placeholder?: string;
  type?: "text" | "email" | "url" | "search" | "password" | "tel" | "number";
  name?: string;
  disabled?: boolean;
} & Rest;

export type SearchFieldProps = {
  value?: string;
  placeholder?: string;
  /** The accessible name. */
  label: string;
} & Rest;

export type ChipProps = { tone?: "default" | "warn" | "bad"; children: Snippet };

export type SegmentedProps<V extends string = string> = {
  options: readonly { value: V; label: string }[];
  value: V;
  /** The group's name, for screen readers. */
  label: string;
  /** Hears a choice (a page that moves its URL rather than binding `value`). */
  onchange?: (value: V) => void;
};

export type NoticeProps = { tone?: "error" | "ok"; children: Snippet };

export type AvatarMarkProps = {
  kind?: "person" | "agent" | "tempra";
  initials: string;
  size?: "default" | "small";
};

export type TileProps = {
  letter: string;
  size?: "small" | "default" | "large";
  shared?: boolean;
};

export type BadgeProps = { count: number };

export type MarkProps = {
  /** At 24px and under: the wider gap that keeps the plates apart. */
  small?: boolean;
  /** Names the mark (role="img"); without it, it is decorative. */
  label?: string;
} & Rest;

export type MenuProps = {
  /** The button's content. */
  label: Snippet;
  /** The button's accessible name, when its content is not one (the avatar). */
  name?: string;
  title?: string;
  buttonClass?: string;
  /** A class for the list, for one that has a shape of its own (the libraries, the bell). */
  listClass?: string;
  align?: "start" | "end";
  /** Opens above its button (a menu at the bottom of the sidebar). */
  up?: boolean;
  /** The list's content; it is handed a way to close the menu (after an action that waits). */
  children: Snippet<[() => void]>;
};

export type DialogProps = {
  title: string;
  open: boolean;
  onClose(): void;
  wide?: boolean;
  children: Snippet;
};

export type ComposeDialogProps = {
  open: boolean;
  onClose(): void;
  /** Where the new thing goes, shown as a chip before the title. */
  context: Snippet;
  title: string;
  action: string;
  busy?: boolean;
  error?: string | null;
  onSubmit(e: SubmitEvent & { currentTarget: HTMLFormElement }): void;
  /** The row under the main fields: small labelled fields (`.compose-field`). */
  fields?: Snippet;
  children: Snippet;
};

export type PanelHeadProps = {
  title: string;
  count?: string | number | null;
  onClose: () => void;
  /** Attributes for the header (the sheet's pointer handlers). */
  [attr: string]: unknown;
};

export type CommentMarkProps = {
  count: number;
  onclick?: (e: MouseEvent) => void;
} & Rest;

export type SelectOption<V extends string = string> = { value: V; label: string };

export type SelectProps<V extends string = string> = {
  /** The choices, in order; a `group` is an `<optgroup>` of its own. */
  options: readonly (SelectOption<V> | { group: string; options: readonly SelectOption<V>[] })[];
  value?: V;
  /** The accessible name, when no visible label names it. */
  label?: string;
  /** `pill` for a filter row (the default), `plain` for a form's field. */
  variant?: "pill" | "plain";
  name?: string;
  disabled?: boolean;
  /** Hears a choice; putting `e.currentTarget.value` back keeps the value (a change to confirm). */
  onchange?: (value: V, e: Event & { currentTarget: HTMLSelectElement }) => void;
} & Rest;

export type ChangeRowProps = {
  /** At the left: the avatar of who changed it. */
  lead?: Snippet;
  /** The line: who did what. */
  children: Snippet;
  /** Under the line: a note, the pages touched, where and by whom. */
  detail?: Snippet;
  /** At the right: when. */
  when?: Snippet;
  /** A further row of the same person's run: no lead, no rule above. */
  continued?: boolean;
  /** An agent writing now. */
  live?: boolean;
} & Rest;
