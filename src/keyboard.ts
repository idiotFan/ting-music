import { $ } from "./dom";
import { mobileDevice } from "./platform";

export type KeyboardOptions = {
  isDetailView: () => boolean;
  isSelecting: () => boolean;
  setSelecting: (on: boolean) => void;
  isTheater: () => boolean;
  setTheater: (on: boolean) => void;
  toggleTheater: () => void;
  goBack: () => void;
  focusSearch: () => void;
  togglePlayback: () => void;
  playFocusedRow: (row: HTMLElement) => void;
  openShortcuts?: () => void;
};

/**
 * Centralized application keyboard shortcuts handler extracted from `main.ts`.
 */
export function setupKeyboardShortcuts(o: KeyboardOptions) {
  document.addEventListener("keydown", (e) => {
    if (document.querySelector("dialog[open]")) return;
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
      e.preventDefault();
      if (o.isTheater()) o.setTheater(false);
      o.focusSearch();
      return;
    }
    // Standard desktop back shortcuts: Alt+Left (all OS) and Cmd+[ (macOS).
    if (
      !mobileDevice &&
      o.isDetailView() &&
      ((e.altKey && e.key === "ArrowLeft") || (e.metaKey && e.key === "["))
    ) {
      e.preventDefault();
      o.goBack();
      return;
    }
    const target = e.target as HTMLElement;
    if (
      e.key === "Enter" &&
      !e.repeat &&
      target.matches(".song-row,.song-title")
    ) {
      e.preventDefault();
      const row = target.closest<HTMLElement>("[data-song]");
      if (row) o.playFocusedRow(row);
      return;
    }
    if (e.key === "Escape" && o.isTheater()) {
      e.preventDefault();
      o.setTheater(false);
      return;
    }
    if (e.key === "Escape" && o.isSelecting()) {
      e.preventDefault();
      o.setSelecting(false);
      return;
    }
    // The lyrics panel owns Escape while open; only the detail view goes back.
    // Text fields keep Escape for themselves, but a focused button must not
    // swallow it: opening a playlist leaves focus on its card.
    if (
      e.key === "Escape" &&
      o.isDetailView() &&
      $("#lyrics-panel").hidden &&
      !target.matches("input,textarea,select")
    ) {
      e.preventDefault();
      o.goBack();
      return;
    }
    if (target.matches("input,textarea,button,select")) return;
    if (e.code === "Space") {
      e.preventDefault();
      o.togglePlayback();
    } else if (
      !mobileDevice &&
      !e.metaKey &&
      !e.ctrlKey &&
      !e.altKey &&
      e.key.toLowerCase() === "f"
    ) {
      e.preventDefault();
      o.toggleTheater();
    } else if (
      !mobileDevice &&
      !e.metaKey &&
      !e.ctrlKey &&
      !e.altKey &&
      e.key === "?"
    ) {
      e.preventDefault();
      o.openShortcuts?.();
    }
  });
}
