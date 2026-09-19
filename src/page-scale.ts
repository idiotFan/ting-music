/** Keep this application at its designed scale without intercepting scrolling. */
export function setupPageScale() {
  const block = (event: Event) => event.preventDefault();
  // Safari/WKWebView trackpads use GestureEvent; Chromium uses Ctrl+wheel.
  document.addEventListener("gesturestart", block, { passive: false });
  document.addEventListener("gesturechange", block, { passive: false });
  document.addEventListener(
    "wheel",
    (event) => {
      if (event.ctrlKey) event.preventDefault();
    },
    { passive: false },
  );
  document.addEventListener("keydown", (event) => {
    if (
      (event.ctrlKey || event.metaKey) &&
      ["+", "=", "-", "0"].includes(event.key)
    )
      event.preventDefault();
  });
}
