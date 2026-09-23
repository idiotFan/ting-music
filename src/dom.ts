import {
  createElement,
  Search,
  Library,
  Heart,
  FolderOpen,
  Music2,
  Play,
  Pause,
  SkipBack,
  SkipForward,
  Volume2,
  VolumeX,
  ListMusic,
  Plus,
  X,
  ArrowUpRight,
  Disc3,
  Headphones,
  Repeat,
  Shuffle,
  Repeat1,
  Download,
  ListOrdered,
  Check,
  LoaderCircle,
  ChevronLeft,
  ChevronRight,
  Ellipsis,
  Palette,
  Cloud,
  UserRound,
  Copy,
  ListPlus,
  ArrowDownUp,
  SlidersHorizontal,
  GripVertical,
  Trash2,
  ListStart,
  Moon,
  History,
  Settings,
  ListChecks,
} from "lucide";

const iconSet = {
  Search,
  Library,
  Heart,
  FolderOpen,
  Music2,
  Play,
  Pause,
  SkipBack,
  SkipForward,
  Volume2,
  VolumeX,
  ListMusic,
  Plus,
  X,
  ArrowUpRight,
  Disc3,
  Headphones,
  Repeat,
  Shuffle,
  Repeat1,
  Download,
  ListOrdered,
  Check,
  LoaderCircle,
  ChevronLeft,
  ChevronRight,
  Ellipsis,
  Palette,
  Cloud,
  UserRound,
  Copy,
  ListPlus,
  ArrowDownUp,
  SlidersHorizontal,
  GripVertical,
  Trash2,
  ListStart,
  Moon,
  History,
  Settings,
  ListChecks,
};
export type IconName = keyof typeof iconSet;

export const $ = <T extends HTMLElement = HTMLElement>(s: string) =>
  document.querySelector<T>(s)!;

const iconCache = new Map<string, string>();
/** Inline SVG markup for a Lucide icon, rendered once and reused. */
export const icon = (name: string) => {
  if (!iconCache.has(name)) {
    const svg = createElement(iconSet[name as IconName]);
    svg.setAttribute("stroke-width", "1.7");
    svg.setAttribute("aria-hidden", "true");
    iconCache.set(name, svg.outerHTML);
  }
  return iconCache.get(name)!;
};
