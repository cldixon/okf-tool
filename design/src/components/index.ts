/**
 * @tempra/design/components (TEMPRA-252): the design system's Svelte 5 components, one per piece
 * of the shared spec (the Paper masters carry the same names). Each draws with the classes in
 * design/src/*.css and nothing else: no `<style>`, no `style:`, nothing inline. The app builds its
 * UI from them; the Worker never imports them.
 *
 * Each export is typed with its props from types.ts: svelte-check in another package sees these
 * .svelte files only as untyped modules, so the types are what it checks a use against.
 */
import type { Component } from "svelte";
import AvatarMarkC from "./AvatarMark.svelte";
import BadgeC from "./Badge.svelte";
import ButtonC from "./Button.svelte";
import ChangeRowC from "./ChangeRow.svelte";
import ChipC from "./Chip.svelte";
import CommentMarkC from "./CommentMark.svelte";
import ComposeDialogC from "./ComposeDialog.svelte";
import DialogC from "./Dialog.svelte";
import DisclosureC from "./Disclosure.svelte";
import FieldC from "./Field.svelte";
import IconC from "./Icon.svelte";
import IconButtonC from "./IconButton.svelte";
import MarkC from "./Mark.svelte";
import MenuC from "./Menu.svelte";
import NoticeC from "./Notice.svelte";
import PanelHeadC from "./PanelHead.svelte";
import PillButtonC from "./PillButton.svelte";
import SearchButtonC from "./SearchButton.svelte";
import SearchFieldC from "./SearchField.svelte";
import SegmentedC from "./Segmented.svelte";
import SelectC from "./Select.svelte";
import SplitButtonC from "./SplitButton.svelte";
import TextInputC from "./TextInput.svelte";
import TileC from "./Tile.svelte";
import ToolPillC from "./ToolPill.svelte";
import type {
  AvatarMarkProps,
  BadgeProps,
  ButtonProps,
  ChangeRowProps,
  ChipProps,
  CommentMarkProps,
  ComposeDialogProps,
  DialogProps,
  DisclosureProps,
  FieldProps,
  IconButtonProps,
  IconProps,
  MarkProps,
  MenuProps,
  NoticeProps,
  PanelHeadProps,
  PillButtonProps,
  SearchButtonProps,
  SearchFieldProps,
  SegmentedProps,
  SelectProps,
  SplitButtonProps,
  TextInputProps,
  TileProps,
  ToolPillProps,
} from "./types";

// biome-ignore lint/complexity/noBannedTypes: Svelte's own default for a component's exports.
type NoExports = {};

export { type Glyph, ICONS } from "./icons";
export { MARK_PATHS, MARK_VIEWBOX, type MarkPaths, markSvg } from "./mark";
export { modal } from "./modal";
export type * from "./types";

export const AvatarMark = AvatarMarkC as Component<AvatarMarkProps>;
export const Badge = BadgeC as Component<BadgeProps>;
export const Button = ButtonC as Component<ButtonProps>;
export const ChangeRow = ChangeRowC as Component<ChangeRowProps>;
export const Chip = ChipC as Component<ChipProps>;
export const CommentMark = CommentMarkC as Component<CommentMarkProps>;
export const ComposeDialog = ComposeDialogC as Component<ComposeDialogProps>;
export const Dialog = DialogC as Component<DialogProps>;
export const Disclosure = DisclosureC as Component<DisclosureProps, NoExports, "open">;
export const Field = FieldC as Component<FieldProps>;
export const Icon = IconC as Component<IconProps>;
export const IconButton = IconButtonC as Component<IconButtonProps>;
export const Mark = MarkC as Component<MarkProps>;
export const Menu = MenuC as Component<MenuProps>;
export const Notice = NoticeC as Component<NoticeProps>;
export const PanelHead = PanelHeadC as Component<PanelHeadProps>;
export const PillButton = PillButtonC as Component<PillButtonProps>;
export const SearchButton = SearchButtonC as Component<SearchButtonProps>;
export const SearchField = SearchFieldC as Component<SearchFieldProps, NoExports, "value">;
export const SplitButton = SplitButtonC as Component<SplitButtonProps>;
export const TextInput = TextInputC as Component<TextInputProps, NoExports, "value">;
export const Tile = TileC as Component<TileProps>;
export const ToolPill = ToolPillC as Component<ToolPillProps>;

export const Segmented = SegmentedC as Component<SegmentedProps, NoExports, "value">;
export const Select = SelectC as Component<SelectProps, NoExports, "value">;
