import { readSetting, writeSetting } from "./settings";

/**
 * Desktop column widths. The list / player split lives on `--player-col`, the
 * lyrics pane on `--lyrics-col`; both persist per machine. Handles are plain
 * separators: pointer drag, arrow keys, double-click to reset.
 */
const KEYS = { player: "ting.columns.player", lyrics: "ting.columns.lyrics" };
export const LIMITS = {
  player: { min: 320, max: 640 },
  lyrics: { min: 260, max: 640 },
  list: { min: 360 },
  app: { min: 400 },
};
const DEFAULT_LYRICS = 320;
const STEP = 16;

type Column = keyof typeof KEYS;

function stored(column: Column): number | undefined {
  const value = Number(readSetting(KEYS[column]));
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

/** The lyrics pane width the native window must grow by when it opens. */
export function lyricsWidth(): number {
  const value = stored("lyrics") ?? DEFAULT_LYRICS;
  return Math.min(Math.max(value, LIMITS.lyrics.min), LIMITS.lyrics.max);
}

export function setupColumns(): void {
  const root = document.documentElement;
  const app = document.querySelector<HTMLElement>("#app")!;
  const panel = document.querySelector<HTMLElement>("#lyrics-panel")!;
  const player = document.querySelector<HTMLElement>(".now-panel")!;

  function apply(column: Column, width: number | undefined) {
    const name = column === "player" ? "--player-col" : "--lyrics-col";
    if (width === undefined) root.style.removeProperty(name);
    else root.style.setProperty(name, `${Math.round(width)}px`);
  }
  for (const column of ["player", "lyrics"] as const)
    apply(column, stored(column));

  const twoColumn = () => getComputedStyle(app).display === "grid";
  // Upper bounds depend on the live window: the other columns keep their minimums.
  function bounds(column: Column) {
    const limit = LIMITS[column];
    const body = document.body.clientWidth;
    const max =
      column === "player"
        ? Math.min(limit.max, app.clientWidth - LIMITS.list.min)
        : Math.min(
            limit.max,
            body -
              (twoColumn()
                ? LIMITS.list.min + LIMITS.player.min
                : LIMITS.app.min),
          );
    return { min: limit.min, max: Math.max(limit.min, max) };
  }
  function current(column: Column) {
    // offsetWidth includes the pane border, so re-applying is idempotent.
    return column === "player" ? player.offsetWidth : panel.offsetWidth;
  }
  function persistWidth(column: Column, width: number) {
    writeSetting(KEYS[column], String(Math.round(width)));
  }
  function set(column: Column, width: number, persist: boolean) {
    const { min, max } = bounds(column);
    const next = Math.min(Math.max(width, min), max);
    if (column === "lyrics" && twoColumn()) {
      // The pane borrows from its neighbour, the player column, so the list
      // keeps its width; only once the player is at its minimum does the list give way.
      const delta = next - current("lyrics");
      const playerNext = Math.min(
        Math.max(current("player") - delta, LIMITS.player.min),
        LIMITS.player.max,
      );
      apply("player", playerNext);
      if (persist) persistWidth("player", playerNext);
    }
    apply(column, next);
    if (persist) persistWidth(column, next);
    return next;
  }
  function reset(column: Column) {
    apply(column, undefined);
    writeSetting(KEYS[column], "");
  }

  function handle(column: Column, label: string, id: string) {
    const separator = document.createElement("div");
    separator.id = id;
    separator.className = "col-resizer";
    separator.setAttribute("role", "separator");
    separator.setAttribute("aria-orientation", "vertical");
    separator.setAttribute("aria-label", label);
    separator.tabIndex = 0;
    let start: { x: number; width: number } | undefined;
    separator.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      start = { x: event.clientX, width: current(column) };
      separator.setPointerCapture(event.pointerId);
      separator.classList.add("dragging");
      document.body.classList.add("column-resizing");
      event.preventDefault();
    });
    separator.addEventListener("pointermove", (event) => {
      if (!start) return;
      // Both columns sit to the right of their handle: dragging right shrinks them.
      set(column, start.width - (event.clientX - start.x), false);
    });
    const finish = () => {
      if (!start) return;
      start = undefined;
      separator.classList.remove("dragging");
      document.body.classList.remove("column-resizing");
      set(column, current(column), true);
    };
    separator.addEventListener("pointerup", finish);
    separator.addEventListener("pointercancel", finish);
    separator.addEventListener("lostpointercapture", finish);
    separator.addEventListener("dblclick", () => reset(column));
    separator.addEventListener("keydown", (event) => {
      const delta =
        event.key === "ArrowLeft"
          ? STEP
          : event.key === "ArrowRight"
            ? -STEP
            : 0;
      if (delta) {
        set(column, current(column) + delta, true);
        event.preventDefault();
      } else if (event.key === "Home" || event.key === "End") {
        const { min, max } = bounds(column);
        set(column, event.key === "Home" ? max : min, true);
        event.preventDefault();
      }
    });
    return separator;
  }
  app.append(handle("player", "调整播放栏宽度", "player-resizer"));
  panel.prepend(handle("lyrics", "调整歌词栏宽度", "lyrics-resizer"));

  // A window that shrinks below a stored width must not leave a column
  // overflowing; re-clamp without touching the stored preference.
  const clamp = () => {
    for (const column of ["player", "lyrics"] as const) {
      const width = stored(column);
      if (width !== undefined)
        apply(column, Math.min(width, bounds(column).max));
    }
  };
  window.addEventListener("resize", clamp);
  clamp();
}
