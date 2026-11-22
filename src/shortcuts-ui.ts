import { icon } from "./dom";
import { closeDialog, openDialog } from "./motion";

const mac = /Mac/i.test(navigator.platform || navigator.userAgent);

const SHORTCUT_ITEMS: { label: string; keys: string[] }[] = [
  { label: "播放 / 暂停", keys: ["Space"] },
  { label: "聚焦搜索框", keys: [mac ? "⌘K" : "Ctrl+K"] },
  { label: "沉浸剧场模式", keys: ["F"] },
  { label: "返回上一页", keys: mac ? ["⌘[", "⌥←"] : ["Alt+←"] },
  { label: "退出剧场 / 关闭弹窗 / 退出多选", keys: ["Esc"] },
  { label: "打开快捷键指南", keys: ["?"] },
];

/**
 * Lightweight desktop keyboard shortcuts cheat sheet modal (`?` or Settings).
 * Keeps shortcut documentation self-contained outside `main.ts`.
 */
export function setupShortcutsSheet() {
  const dialog = document.createElement("dialog");
  dialog.id = "shortcuts-dialog";
  dialog.setAttribute("aria-labelledby", "shortcuts-title");
  dialog.innerHTML = `<header class="settings-header"><h2 id="shortcuts-title">快捷键指南</h2><button class="dialog-close icon-button" data-shortcuts-close aria-label="关闭快捷键指南">${icon("X")}</button></header><div class="shortcuts-grid">${SHORTCUT_ITEMS.map(
    (item) =>
      `<div class="shortcuts-item"><span>${item.label}</span><span class="shortcuts-keys">${item.keys.map((k) => `<kbd>${k}</kbd>`).join("")}</span></div>`,
  ).join("")}</div>`;
  document.body.append(dialog);
  dialog.addEventListener("click", (e) => {
    const el = e.target as HTMLElement;
    if (e.target === dialog || el.closest("[data-shortcuts-close]")) {
      closeDialog(dialog);
    }
  });
  return {
    open: () => openDialog(dialog),
    close: () => closeDialog(dialog),
    isOpen: () => dialog.open,
  };
}
