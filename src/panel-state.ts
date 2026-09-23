/** What the main window tells the mini player and the floating lyrics. */
export type PlayerState = {
  title: string;
  artist: string;
  cover: string;
  playing: boolean;
  position: number;
  duration: number;
  hasSong: boolean;
};
export type LyricLine = { text: string; next: string; locked: boolean };
export type PlayerCommand =
  | "toggle"
  | "previous"
  | "next"
  | "volume-up"
  | "volume-down"
  | "lyrics"
  | "lyrics-closed"
  | "lyrics-lock"
  | "show"
  | "hello"
  | "lyrics-hello";
