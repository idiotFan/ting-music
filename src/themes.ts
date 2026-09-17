import { readSetting } from "./settings";
export const themes = [
  {
    id: "sage",
    name: "晨绿",
    bg: "#f8faf5",
    surface: "#fcfdf9",
    ink: "#2d4034",
    muted: "#65715f",
    accent: "#36573d",
    line: "#e4e9de",
  },
  {
    id: "porcelain",
    name: "月白",
    bg: "#f4f5f7",
    surface: "#ffffff",
    ink: "#272d35",
    muted: "#656d78",
    accent: "#455b77",
    line: "#e3e6eb",
  },
  {
    id: "mist",
    name: "雾蓝",
    bg: "#f0f5fa",
    surface: "#fbfdff",
    ink: "#293b50",
    muted: "#617389",
    accent: "#376695",
    line: "#dce5ef",
  },
  {
    id: "sea",
    name: "海盐",
    bg: "#eff7f6",
    surface: "#fafffe",
    ink: "#264644",
    muted: "#5b7570",
    accent: "#28746a",
    line: "#dceae5",
  },
  {
    id: "apricot",
    name: "暖杏",
    bg: "#faf4ec",
    surface: "#fffcf7",
    ink: "#493d31",
    muted: "#7c6d5c",
    accent: "#916336",
    line: "#eadecf",
  },
  {
    id: "rose",
    name: "玫瑰",
    bg: "#faf2f4",
    surface: "#fffafb",
    ink: "#4c343e",
    muted: "#816875",
    accent: "#965b73",
    line: "#eedee5",
  },
  {
    id: "lavender",
    name: "藤紫",
    bg: "#f4f2f9",
    surface: "#fdfbff",
    ink: "#403750",
    muted: "#746a84",
    accent: "#775899",
    line: "#e6dfed",
  },
  {
    id: "sand",
    name: "砂岩",
    bg: "#f5f2ed",
    surface: "#fcfaf6",
    ink: "#403d37",
    muted: "#747065",
    accent: "#716248",
    line: "#e5dfd5",
  },
  {
    id: "midnight",
    name: "午夜蓝",
    bg: "#111923",
    surface: "#16202d",
    ink: "#e3eaf3",
    muted: "#a2b1c4",
    accent: "#90b7e6",
    line: "#2a3748",
    dark: true,
  },
  {
    id: "forest",
    name: "深墨绿",
    bg: "#101e19",
    surface: "#14261f",
    ink: "#e0ece4",
    muted: "#a1b6a7",
    accent: "#9ecbb0",
    line: "#2a4034",
    dark: true,
  },
  {
    id: "graphite",
    name: "石墨",
    bg: "#191a1d",
    surface: "#212226",
    ink: "#ebebed",
    muted: "#b0b0b8",
    accent: "#c8bddf",
    line: "#36373d",
    dark: true,
  },
];
let selected = readSetting("ting.theme") || "sage";
if (!themes.some((t) => t.id === selected)) selected = "sage";
function apply(id: string) {
  const t = themes.find((t) => t.id === id)!;
  const root = document.documentElement;
  root.dataset.theme = id;
  root.style.colorScheme = t.dark ? "dark" : "light";
  for (const key of [
    "bg",
    "surface",
    "ink",
    "muted",
    "accent",
    "line",
  ] as const)
    root.style.setProperty("--" + key, t[key]);
  root.style.setProperty("--on-accent", t.dark ? "#14201b" : "#ffffff");
  root.style.setProperty("--error", t.dark ? "#efa6a2" : "#9b443d");
  selected = id;
}
apply(selected);
export function setupThemes() {
  const dialog = document.createElement("dialog");
  dialog.id = "theme-dialog";
  dialog.setAttribute("aria-labelledby", "theme-title");
  dialog.innerHTML = `<button class="dialog-close icon-button" id="theme-close" aria-label="关闭主题选择">×</button><h2 id="theme-title">选一种心情</h2><p class="summary">晨绿 + 10 套配色，选择后立即生效。</p><div class="theme-grid">${themes.map((t) => `<button class="theme-choice" data-theme-choice="${t.id}" aria-pressed="false"><span class="theme-preview" style="--swatch-bg:${t.bg};--swatch-surface:${t.surface};--swatch-ink:${t.ink};--swatch-accent:${t.accent}"><i></i><b></b><em></em></span><span>${t.name}</span></button>`).join("")}</div>`;
  document.body.append(dialog);
  const update = () =>
    dialog
      .querySelectorAll<HTMLElement>("[data-theme-choice]")
      .forEach((b) =>
        b.setAttribute(
          "aria-pressed",
          String(b.dataset.themeChoice === selected),
        ),
      );
  dialog.querySelector<HTMLButtonElement>("#theme-close")!.onclick = () =>
    dialog.close();
  dialog.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>(
      "[data-theme-choice]",
    );
    if (!b) return;
    apply(b.dataset.themeChoice!);
    update();
    try {
      localStorage.setItem("ting.theme", selected);
    } catch {}
  });
  document.querySelector<HTMLButtonElement>("#theme-button")!.onclick = () => {
    update();
    dialog.showModal();
  };
}
