import fs from '@ohos.file.fs';
import { picker } from '@kit.CoreFileKit';
import common from '@ohos.app.ability.common';
import { UIContext } from '@ohos.arkui.UIContext';
import { hilog } from '@kit.PerformanceAnalysisKit';

const DOMAIN = 0x0000;
const AUDIO = ['mp3', 'flac', 'm4a', 'wav', 'ogg', 'aac'];

interface Entry {
  name: string;
  path: string;
  mtime: number;
}

/**
 * Lists the songs saved in the app sandbox and lets the listener export one to
 * a location of their choice, mirroring the Android "save or share" sheet.
 */
export function openDownloads(context: common.UIAbilityContext, ui: UIContext, dir: string): void {
  let entries: Entry[] = [];
  try {
    if (fs.accessSync(dir)) {
      entries = fs.listFileSync(dir)
        .filter((name: string) => AUDIO.includes(name.split('.').pop()?.toLowerCase() ?? ''))
        .map((name: string): Entry => {
          const path = `${dir}/${name}`;
          return { name, path, mtime: fs.statSync(path).mtime };
        })
        .sort((a: Entry, b: Entry) => b.mtime - a.mtime);
    }
  } catch (error) {
    hilog.warn(DOMAIN, 'Ting', 'download listing failed: %{public}s', String((error as Error)?.message));
  }
  if (entries.length === 0) {
    ui.showAlertDialog({ title: 'Ting 下载', message: '还没有下载的歌曲', confirm: { value: '好', action: () => {} } });
    return;
  }
  ui.showActionSheet({
    title: 'Ting 下载 · 点击保存到文件',
    message: `${entries.length} 首`,
    confirm: { value: '关闭', action: () => {} },
    sheets: entries.slice(0, 30).map((entry: Entry): SheetInfo => ({
      title: entry.name,
      action: () => {
        exportFile(context, entry).catch((error: Error) => {
          hilog.warn(DOMAIN, 'Ting', 'export failed: %{public}s', String(error?.message));
          ui.showAlertDialog({ title: '保存失败', message: '无法保存该文件，请重试', confirm: { value: '好', action: () => {} } });
        });
      },
    })),
  });
}

/** Copies one sandbox file into the URI the system picker hands back. */
export async function exportFile(context: common.UIAbilityContext, entry: Entry): Promise<void> {
  const options = new picker.DocumentSaveOptions();
  options.newFileNames = [entry.name];
  const uris = await new picker.DocumentViewPicker(context).save(options);
  if (!uris || uris.length === 0) {
    return; // cancelled
  }
  const target = fs.openSync(uris[0], fs.OpenMode.READ_WRITE | fs.OpenMode.CREATE | fs.OpenMode.TRUNC);
  try {
    fs.copyFileSync(entry.path, target.fd);
  } finally {
    fs.closeSync(target);
  }
}
