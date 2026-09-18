import { invoke, isTauri } from "@tauri-apps/api/core";

function canvas() {
  const value = document.createElement("canvas");
  value.width = value.height = 512;
  return value;
}
export function fallbackArtwork(): MediaImage {
  const image = canvas(),
    context = image.getContext("2d")!;
  context.fillStyle = "#a6ed55";
  context.fillRect(0, 0, 512, 512);
  context.fillStyle = "#173323";
  context.font = "bold 280px sans-serif";
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillText("听", 256, 264);
  return {
    src: image.toDataURL("image/png"),
    sizes: "512x512",
    type: "image/png",
  };
}
export async function loadMediaArtwork(url: string): Promise<MediaImage> {
  // Tauri's custom origin and WebKit's system artwork loader must not need to
  // fetch the CDN again. Rust uses a bounded, credential-free allowlisted request.
  const src = isTauri() ? await invoke<string>("media_artwork", { url }) : url;
  return new Promise((resolve, reject) => {
    const image = new Image();
    const timeout = window.setTimeout(() => {
      image.onload = image.onerror = null;
      image.src = "";
      reject(new Error("封面加载超时"));
    }, 10_000);
    image.crossOrigin = "anonymous";
    image.onerror = () => {
      clearTimeout(timeout);
      reject(new Error("封面加载失败"));
    };
    image.onload = () => {
      clearTimeout(timeout);
      try {
        const out = canvas();
        out.getContext("2d")!.drawImage(image, 0, 0, 512, 512);
        resolve({
          src: out.toDataURL("image/png"),
          sizes: "512x512",
          type: "image/png",
        });
      } catch (error) {
        reject(error);
      }
    };
    image.src = src;
  });
}
