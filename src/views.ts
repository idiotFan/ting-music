import { MOTION } from "./motion";

export type View =
  | "discover"
  | "favorites"
  | "local"
  | "queue"
  | "playlists"
  | "playlist"
  | "artist"
  | "album";
/** Pages one layer below the nav: entered by pushing, left through goBack. */
export const DETAIL_VIEWS: View[] = ["playlist", "artist", "album"];
export const isDetail = (v: View) => DETAIL_VIEWS.includes(v);
// The nav renders these in order, so a tap that moves right must bring its
// content in from the right. A playlist detail is one layer deeper instead.
export const NAV_ORDER: View[] = [
  "discover",
  "playlists",
  "favorites",
  "local",
  "queue",
];
export type Move = { direction: -1 | 1; distance: number; duration: number };
export function viewMove(previous: View, next: View, back = false): Move {
  if (back && isDetail(previous))
    return { direction: -1, distance: MOTION.dPush, duration: MOTION.t3 };
  if (isDetail(next))
    return { direction: 1, distance: MOTION.dPush, duration: MOTION.t4 };
  if (isDetail(previous))
    return { direction: -1, distance: MOTION.dPush, duration: MOTION.t3 };
  const from = NAV_ORDER.indexOf(previous),
    to = NAV_ORDER.indexOf(next);
  return {
    direction: from < 0 || to < 0 || to >= from ? 1 : -1,
    distance: MOTION.dLateral,
    duration: MOTION.t3,
  };
}
