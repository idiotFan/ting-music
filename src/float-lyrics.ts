import { invoke } from "@tauri-apps/api/core";
import { emitTo, listen } from "@tauri-apps/api/event";
import { icon } from "./dom";
import "./themes";
import "./panels.css";
import type { LyricLine, PlayerCommand } from "./panel-state";

/**
 * Floating lyrics: the current line large, the next one small, on a clear
 * strip. Hovering shows the controls; locking lets clicks pass through (the
 * lock is released from the tray, settings or the main window's shortcut).
 */
const root = document.querySelector<HTMLElement>("#float")!;
let size = Number(localStorage.getItem("ting.float-size")) || 30;
root.innerHTML = `<div class="float-strip" data-tauri-drag-region><p id="float-line" data-tauri-drag-region>听 · Ting</p><p id="float-next" data-tauri-drag-region></p><div class="float-tools"><button data-size="-1" aria-label="缩小字号">A−</button><button data-size="1" aria-label="放大字号">A+</button><button data-lock aria-label="锁定">锁定</button><button data-close aria-label="关闭桌面歌词">${icon("X")}</button></div></div>`;
const applySize = () => root.style.setProperty("--float-size", `${size}px`);
applySize();
const send = (cmd: PlayerCommand) => void emitTo("main", "player-command", cmd);
root.addEventListener("click", (e) => {
  const el = e.target as HTMLElement;
  const step = el.closest<HTMLElement>("[data-size]");
  if (step) {
    size = Math.min(56, Math.max(18, size + Number(step.dataset.size) * 3));
    localStorage.setItem("ting.float-size", String(size));
    applySize();
  }
  if (el.closest("[data-lock]")) send("lyrics-lock");
  if (el.closest("[data-close]")) {
    send("lyrics-closed");
    void invoke("float_lyrics", { show: false });
  }
});
void listen<LyricLine>("lyric-line", ({ payload }) => {
  const line = document.querySelector("#float-line")!;
  if (line.textContent !== payload.text) {
    line.textContent = payload.text || "♪";
    line.animate?.([{ opacity: 0.35 }, { opacity: 1 }], {
      duration: 220,
      easing: "ease-out",
    });
  }
  document.querySelector("#float-next")!.textContent = payload.next;
  root.classList.toggle("locked", payload.locked);
});
send("hello");
