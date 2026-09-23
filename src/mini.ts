import { invoke } from "@tauri-apps/api/core";
import { emitTo, listen } from "@tauri-apps/api/event";
import { icon } from "./dom";
import "./themes";
import "./panels.css";
import type { PlayerCommand, PlayerState } from "./panel-state";

/**
 * The mini player: cover, title, three buttons and a thin progress line. It
 * holds no audio of its own — every press goes to the main window, which
 * answers with its state.
 */
const root = document.querySelector<HTMLElement>("#mini")!;
root.innerHTML = `<div class="mini-card" data-tauri-drag-region><span class="mini-cover" data-tauri-drag-region></span><div class="mini-text" data-tauri-drag-region><strong id="mini-title" data-tauri-drag-region>听 · Ting</strong><small id="mini-artist" data-tauri-drag-region>未在播放</small></div><div class="mini-buttons"><button data-cmd="previous" aria-label="上一首">${icon("SkipBack")}</button><button data-cmd="toggle" id="mini-toggle" aria-label="播放">${icon("Play")}</button><button data-cmd="next" aria-label="下一首">${icon("SkipForward")}</button><button data-close aria-label="关闭迷你播放器" class="mini-close">${icon("X")}</button></div><i class="mini-progress"><b id="mini-bar"></b></i></div>`;
const send = (cmd: PlayerCommand) => void emitTo("main", "player-command", cmd);
root.addEventListener("click", (e) => {
  const el = e.target as HTMLElement;
  const cmd = el.closest<HTMLElement>("[data-cmd]")?.dataset.cmd as
    PlayerCommand | undefined;
  if (cmd) send(cmd);
  if (el.closest("[data-close]")) void invoke("mini_player");
});
root.addEventListener("dblclick", (e) => {
  if ((e.target as HTMLElement).closest("button")) return;
  // Double-click the card to bring the main window back.
  send("show");
});
let last = "";
void listen<PlayerState>("player-state", ({ payload: s }) => {
  document.querySelector("#mini-title")!.textContent = s.hasSong
    ? s.title
    : "听 · Ting";
  document.querySelector("#mini-artist")!.textContent = s.hasSong
    ? s.artist
    : "未在播放";
  const cover = document.querySelector<HTMLElement>(".mini-cover")!;
  if (cover.dataset.src !== s.cover) {
    cover.dataset.src = s.cover;
    cover.innerHTML = s.cover
      ? `<img src="${s.cover.replace(/"/g, "&quot;")}" alt="" referrerpolicy="no-referrer" data-tauri-drag-region/>`
      : icon("Music2");
  }
  const glyph = s.playing ? "Pause" : "Play";
  if (last !== glyph) {
    last = glyph;
    const toggle = document.querySelector<HTMLElement>("#mini-toggle")!;
    toggle.innerHTML = icon(glyph);
    toggle.setAttribute("aria-label", s.playing ? "暂停" : "播放");
  }
  document
    .querySelector<HTMLElement>("#mini-bar")!
    .style.setProperty(
      "--p",
      String(s.duration ? Math.min(1, s.position / s.duration) : 0),
    );
});
send("hello");
