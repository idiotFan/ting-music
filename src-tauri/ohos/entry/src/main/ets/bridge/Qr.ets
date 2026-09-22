import fs from '@ohos.file.fs';
import { picker } from '@kit.CoreFileKit';
import { util } from '@kit.ArkTS';
import common from '@ohos.app.ability.common';
import { hilog } from '@kit.PerformanceAnalysisKit';

const DOMAIN = 0x0000;
const PREFIX = 'data:image/png;base64,';

/**
 * Writes the verified login QR PNG to the cache and lets the listener save it
 * through the system file picker; the bytes are never re-encoded. Rust has
 * already bounded the size and dimensions.
 */
export function saveQr(context: common.UIAbilityContext, dataUrl: string): void {
  if (!dataUrl.startsWith(PREFIX)) {
    throw new Error('not a png data url');
  }
  const bytes = new util.Base64Helper().decodeSync(dataUrl.substring(PREFIX.length));
  const folder = `${context.cacheDir}/login-qr`;
  if (!fs.accessSync(folder)) {
    fs.mkdirSync(folder);
  }
  // Drop exports older than ten minutes, including leftovers from an interrupted save.
  const now = Date.now();
  for (const name of fs.listFileSync(folder)) {
    const path = `${folder}/${name}`;
    if (name.startsWith('Ting-login-') && now - fs.statSync(path).mtime * 1000 > 600_000) {
      fs.unlinkSync(path);
    }
  }
  const name = `Ting-login-${util.generateRandomUUID()}.png`;
  const path = `${folder}/${name}`;
  const file = fs.openSync(path, fs.OpenMode.READ_WRITE | fs.OpenMode.CREATE | fs.OpenMode.TRUNC);
  try {
    fs.writeSync(file.fd, bytes.buffer);
  } finally {
    fs.closeSync(file);
  }
  const options = new picker.DocumentSaveOptions();
  options.newFileNames = [name];
  new picker.DocumentViewPicker(context).save(options)
    .then((uris: string[]) => {
      if (!uris || uris.length === 0) {
        return;
      }
      const target = fs.openSync(uris[0], fs.OpenMode.READ_WRITE | fs.OpenMode.CREATE | fs.OpenMode.TRUNC);
      try {
        fs.copyFileSync(path, target.fd);
      } finally {
        fs.closeSync(target);
      }
    })
    .catch((error: Error) => {
      hilog.warn(DOMAIN, 'Ting', 'qr save failed: %{public}s', String(error?.message));
    });
}
