import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { platform } from "./platform";
import { createNativeSession } from "./native-media-session.mjs";

export async function systemMediaBackend() {
  let degraded = false;
  // WKWebView owns the actual HTMLAudioElement session in its media process.
  // Publishing a second MPNowPlayingInfoCenter in the host cannot take it over.
  // Keep Apple metadata and commands on that real audio session.
  if (isTauri() && !platform.ios && !platform.mac) {
    let unlisten: (() => void) | undefined;
    const session = createNativeSession({
      update: (snapshot: unknown) =>
        invoke("system_media_update", { snapshot }),
      onError: () => window.dispatchEvent(new Event("system-media-error")),
    });
    try {
      unlisten = await listen("system-media-action", (event) =>
        session.dispatch(event.payload),
      );
      const backend = await invoke<string>("system_media_init");
      if (!["windows", "mpris", "android"].includes(backend))
        throw Error("unsupported");
      // Do not register web actions as well: two owners can hide buttons or
      // dispatch the same media key twice. Browser previews retain the web API.
      if (navigator.mediaSession) {
        for (const action of [
          "play",
          "pause",
          "previoustrack",
          "nexttrack",
          "seekto",
          "seekbackward",
          "seekforward",
        ] as MediaSessionAction[]) {
          try {
            navigator.mediaSession.setActionHandler(action, null);
          } catch {
            /* optional */
          }
        }
        navigator.mediaSession.metadata = null;
        navigator.mediaSession.playbackState = "none";
      }
      window.addEventListener(
        "pagehide",
        () => {
          unlisten?.();
          session.dispose();
        },
        { once: true },
      );
      return { session, metadata: (value: MediaMetadataInit) => value };
    } catch {
      unlisten?.();
      session.dispose();
      degraded = true;
    }
  }
  return {
    degraded,
    session: navigator.mediaSession,
    metadata: (value: MediaMetadataInit) => {
      const current = navigator.mediaSession?.metadata;
      if (!current) return new MediaMetadata(value);
      // Replacing the entire object makes WebKit discard its decoded artwork.
      // Update text in place and leave the displayed image until it changes.
      for (const key of ["title", "artist", "album"] as const)
        if (current[key] !== (value[key] ?? ""))
          current[key] = value[key] ?? "";
      const images = value.artwork ?? [];
      if (
        current.artwork.length !== images.length ||
        images.some((image, i) =>
          (["src", "sizes", "type"] as const).some(
            (key) => (current.artwork[i][key] ?? "") !== (image[key] ?? ""),
          ),
        )
      )
        current.artwork = images;
      return current;
    },
  };
}
