/** WKWebView's keyboard can shrink the visual viewport without changing 100dvh. */
export function setupMobileViewport(mobile: boolean): () => void {
  const viewport = window.visualViewport;
  if (!mobile || !viewport) return () => {};

  const root = document.documentElement;
  let frame = 0;
  let keyboardOpen = false;
  const set = (name: string, value: number) => {
    const pixels = `${Math.round(value * 100) / 100}px`;
    if (root.style.getPropertyValue(name) !== pixels)
      root.style.setProperty(name, pixels);
  };
  function update() {
    frame = 0;
    // Resizing the app while zooming would fight the user's pan and reflow text.
    if (!viewport || Math.abs(viewport.scale - 1) > 0.01) return;
    if (!Number.isFinite(viewport.height) || viewport.height <= 0) return;
    const layoutHeight = Math.max(innerHeight, root.clientHeight);
    const height = Math.min(layoutHeight, viewport.height);
    const top = Math.max(0, viewport.offsetTop);
    const inset = Math.max(0, layoutHeight - height - top);
    const focused = document.activeElement;
    const editing =
      focused instanceof HTMLElement &&
      focused.matches(
        'input:not([type="range"]):not([type="checkbox"]):not([type="radio"]):not([type="button"]):not([type="submit"]), textarea, [contenteditable="true"]',
      );
    // Keep the state during the keyboard's closing animation after input blur.
    keyboardOpen = layoutHeight - height > 80 && (editing || keyboardOpen);
    set("--mobile-viewport-height", height);
    set("--mobile-viewport-top", top);
    set("--mobile-keyboard-inset", inset);
    root.classList.toggle("keyboard-open", keyboardOpen);

    // Scroll the sheet itself, never the document, to reveal the focused field.
    const dialog = editing
      ? focused.closest<HTMLDialogElement>("dialog[open]")
      : null;
    if (dialog && keyboardOpen && focused) {
      const field = focused.getBoundingClientRect();
      const sheet = dialog.getBoundingClientRect();
      const lower = Math.min(sheet.bottom, top + height) - 16;
      const upper = Math.max(sheet.top, top) + 16;
      if (field.bottom > lower) dialog.scrollTop += field.bottom - lower;
      else if (field.top < upper) dialog.scrollTop -= upper - field.top;
    }
  }
  function schedule() {
    if (!frame) frame = requestAnimationFrame(update);
  }
  viewport.addEventListener("resize", schedule);
  viewport.addEventListener("scroll", schedule);
  window.addEventListener("resize", schedule);
  document.addEventListener("focusin", schedule);
  document.addEventListener("focusout", schedule);
  update();
  return () => {
    cancelAnimationFrame(frame);
    viewport.removeEventListener("resize", schedule);
    viewport.removeEventListener("scroll", schedule);
    window.removeEventListener("resize", schedule);
    document.removeEventListener("focusin", schedule);
    document.removeEventListener("focusout", schedule);
    root.classList.remove("keyboard-open");
    for (const name of [
      "--mobile-viewport-height",
      "--mobile-viewport-top",
      "--mobile-keyboard-inset",
    ])
      root.style.removeProperty(name);
  };
}
