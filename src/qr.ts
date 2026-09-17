import QRCode from "qrcode";
import jsQR from "jsqr";

/** Encode deterministically, then decode the actual PNG before showing it. */
export async function makeLoginQr(
  payload: string,
  maxSize = 340,
): Promise<string> {
  const modules =
    QRCode.create(payload, { errorCorrectionLevel: "M" }).modules.size + 8;
  const scale = Math.max(2, Math.floor(maxSize / modules / 2) * 2);
  const src = await QRCode.toDataURL(payload, {
    errorCorrectionLevel: "M",
    margin: 4,
    scale,
    color: { dark: "#000000", light: "#ffffff" },
  });
  const image = new Image();
  image.src = src;
  await image.decode();
  const canvas = document.createElement("canvas");
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("无法校验登录二维码，请重试");
  context.drawImage(image, 0, 0);
  const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
  const decoded = jsQR(pixels.data, pixels.width, pixels.height);
  if (decoded?.data !== payload)
    throw new Error("二维码完整性校验失败，请刷新二维码");
  return src;
}

/** Preserve platform QR pixels; fit oversized originals deterministically and verify both images. */
export async function verifyOriginalQr(
  src: string,
  maxSize: number,
): Promise<{ src: string; payload: string; width: number }> {
  if (!/^data:image\/(png|jpeg);base64,/.test(src))
    throw new Error("二维码格式不受支持");
  const image = new Image();
  image.src = src;
  await image.decode();
  const canvas = document.createElement("canvas");
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("无法校验二维码");
  ctx.drawImage(image, 0, 0);
  const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const decoded = jsQR(pixels.data, pixels.width, pixels.height);
  if (!decoded?.data) throw new Error("QQ 二维码完整性校验失败，请刷新");
  if (image.naturalWidth > maxSize || image.naturalHeight > maxSize) {
    // WeChat supplies a 470px JPEG. Integer reduction keeps its 10px modules sharp;
    // retain the entire original and add white quiet space, never regenerate the code.
    const padding = 8;
    const divisor = Math.ceil(
      Math.max(image.naturalWidth, image.naturalHeight) /
        (maxSize - padding * 2),
    );
    const width = Math.ceil(image.naturalWidth / divisor),
      height = Math.ceil(image.naturalHeight / divisor);
    const fitted = document.createElement("canvas");
    fitted.width = width + padding * 2;
    fitted.height = height + padding * 2;
    const fit = fitted.getContext("2d", { willReadFrequently: true });
    if (!fit) throw new Error("无法校验二维码");
    fit.fillStyle = "#fff";
    fit.fillRect(0, 0, fitted.width, fitted.height);
    fit.imageSmoothingEnabled = false;
    fit.drawImage(image, padding, padding, width, height);
    const finalPixels = fit.getImageData(0, 0, fitted.width, fitted.height);
    const finalCode = jsQR(
      finalPixels.data,
      finalPixels.width,
      finalPixels.height,
    );
    if (finalCode?.data !== decoded.data)
      throw new Error("二维码适配校验失败，请刷新二维码");
    return {
      src: fitted.toDataURL("image/png"),
      payload: decoded.data,
      width: fitted.width,
    };
  }
  return {
    src,
    payload: decoded.data,
    width:
      image.naturalWidth *
      Math.max(1, Math.floor(maxSize / image.naturalWidth)),
  };
}
