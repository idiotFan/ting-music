#!/usr/bin/env python3
"""Repack Linux AppImages without the bundled Wayland client libraries.

linuxdeploy copies libwayland-* from the build host into the AppImage. Mixed
with a newer host Mesa (Arch, Manjaro, Fedora...) WebKit's web process aborts
with "Could not create default EGL display: EGL_BAD_PARAMETER" and the window
stays blank. Every GTK desktop ships these libraries, so the host's copy is
used instead. Re-signs the updater signature when the signing key is present.
"""
import os
from pathlib import Path
import platform
import shutil
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]
BUNDLE = ROOT / 'src-tauri/target/release/bundle/appimage'
PLUGIN = Path(os.environ.get('TING_APPIMAGE_PLUGIN', Path.home() / '.cache/tauri/linuxdeploy-plugin-appimage.AppImage'))
ARCH = {'x86_64': 'x86_64', 'amd64': 'x86_64', 'aarch64': 'aarch64', 'arm64': 'aarch64'}[platform.machine().lower()]


def extract(image, into):
    into.mkdir()
    subprocess.run([str(image), '--appimage-extract'], cwd=into, check=True, stdout=subprocess.DEVNULL)
    return into / 'squashfs-root'


def wayland(appdir):
    return sorted(p for p in (appdir / 'usr/lib').rglob('libwayland-*.so*'))


def repack(image, tool, work):
    appdir = extract(image, work / 'app')
    removed = wayland(appdir)
    for lib in removed:
        lib.unlink()
    out = work / image.name
    subprocess.run([str(tool), '--no-appstream', str(appdir), str(out)], check=True,
                   env={**os.environ, 'ARCH': ARCH}, stdout=subprocess.DEVNULL)
    out.chmod(0o755)
    check = extract(out, work / 'check')
    if wayland(check) or not (check / 'usr/bin/ting-music').is_file():
        raise SystemExit(f'{image.name}: repacked AppImage is incomplete')
    shutil.move(out, image)
    sig = Path(f'{image}.sig')
    if os.environ.get('TAURI_SIGNING_PRIVATE_KEY'):
        sig.unlink(missing_ok=True)
        subprocess.run([shutil.which('node') or 'node', str(ROOT / 'node_modules/@tauri-apps/cli/tauri.js'),
                        'signer', 'sign', str(image)], check=True, stdout=subprocess.DEVNULL,
                       env={'TAURI_SIGNING_PRIVATE_KEY_PASSWORD': '', **os.environ})
        if not sig.is_file():
            raise SystemExit(f'{image.name}: updater signature was not written')
    else:
        # A signature of the original file would no longer verify.
        sig.unlink(missing_ok=True)
    print(f'{image.name}: removed {", ".join(p.name for p in removed) or "nothing"}')


def main():
    images = [Path(p) for p in sys.argv[1:]] or sorted(BUNDLE.glob('*.AppImage'))
    if not images:
        raise SystemExit('No AppImage found')
    if not PLUGIN.is_file():
        raise SystemExit(f'appimagetool source not found: {PLUGIN}')
    with tempfile.TemporaryDirectory() as tmp:
        tool = extract(PLUGIN, Path(tmp) / 'tool') / 'appimagetool-prefix/AppRun'
        for i, image in enumerate(images):
            work = Path(tmp) / str(i)
            work.mkdir()
            repack(image.resolve(), tool, work)


if __name__ == '__main__':
    main()
