/** The glyphs the design system draws, by the names the app uses (Icon, IconButton). */
import Activity from "@lucide/svelte/icons/activity";
import ArrowLeft from "@lucide/svelte/icons/arrow-left";
import AudioLines from "@lucide/svelte/icons/audio-lines";
import Bell from "@lucide/svelte/icons/bell";
import Check from "@lucide/svelte/icons/check";
import ChevronDown from "@lucide/svelte/icons/chevron-down";
import ChevronLeft from "@lucide/svelte/icons/chevron-left";
import ChevronRight from "@lucide/svelte/icons/chevron-right";
import ChevronsUpDown from "@lucide/svelte/icons/chevrons-up-down";
import CircleCheck from "@lucide/svelte/icons/circle-check";
import CirclePlus from "@lucide/svelte/icons/circle-plus";
import ClockAlert from "@lucide/svelte/icons/clock-alert";
import Code from "@lucide/svelte/icons/code";
import Copy from "@lucide/svelte/icons/copy";
import Download from "@lucide/svelte/icons/download";
import Ellipsis from "@lucide/svelte/icons/ellipsis";
import ExternalLink from "@lucide/svelte/icons/external-link";
import FileText from "@lucide/svelte/icons/file-text";
import Film from "@lucide/svelte/icons/film";
import History from "@lucide/svelte/icons/history";
import Hourglass from "@lucide/svelte/icons/hourglass";
import House from "@lucide/svelte/icons/house";
import ImageOff from "@lucide/svelte/icons/image-off";
import Inbox from "@lucide/svelte/icons/inbox";
import LayoutGrid from "@lucide/svelte/icons/layout-grid";
import Link from "@lucide/svelte/icons/link";
import List from "@lucide/svelte/icons/list";
import LogOut from "@lucide/svelte/icons/log-out";
import Maximize2 from "@lucide/svelte/icons/maximize-2";
import Menu from "@lucide/svelte/icons/menu";
import MessageSquare from "@lucide/svelte/icons/message-square";
import PanelLeft from "@lucide/svelte/icons/panel-left";
import Plug from "@lucide/svelte/icons/plug";
import Plus from "@lucide/svelte/icons/plus";
import RefreshCw from "@lucide/svelte/icons/refresh-cw";
import Search from "@lucide/svelte/icons/search";
import Settings from "@lucide/svelte/icons/settings";
import SlidersHorizontal from "@lucide/svelte/icons/sliders-horizontal";
import SunMoon from "@lucide/svelte/icons/sun-moon";
import User from "@lucide/svelte/icons/user";
import X from "@lucide/svelte/icons/x";

/*
 * The icons are Lucide's (the set the handoff asks for), at 16px with a 1.5 stroke, drawn in
 * the current text colour.
 */
export const ICONS = {
  refresh: RefreshCw,
  markdown: Code,
  comments: MessageSquare,
  review: CircleCheck,
  contents: List,
  history: History,
  properties: SlidersHorizontal,
  plus: CirclePlus,
  sidebar: PanelLeft,
  chevron: ChevronRight,
  stale: ClockAlert,
  soon: Hourglass,
  down: ChevronDown,
  updown: ChevronsUpDown,
  home: House,
  activity: Activity,
  inbox: Inbox,
  search: Search,
  more: Ellipsis,
  menu: Menu,
  close: X,
  x: X,
  back: ArrowLeft,
  previous: ChevronLeft,
  next: ChevronRight,
  enlarge: Maximize2,
  download: Download,
  open: ExternalLink,
  file: FileText,
  broken: ImageOff,
  video: Film,
  audio: AudioLines,
  bell: Bell,
  check: Check,
  settings: Settings,
  libraries: LayoutGrid,
  user: User,
  plug: Plug,
  theme: SunMoon,
  signout: LogOut,
  copy: Copy,
  link: Link,
  add: Plus,
} as const;

export type Glyph = keyof typeof ICONS;
