#!/usr/bin/env python3
"""Produce verified local release archives. Never installs, uploads, or overwrites an app."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import plistlib
import shutil
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]
MACHO = {b'\xfe\xed\xfa\xce', b'\xce\xfa\xed\xfe', b'\xfe\xed\xfa\xcf', b'\xcf\xfa\xed\xfe', b'\xca\xfe\xba\xbe', b'\xbe\xba\xfe\xca', b'\xca\xfe\xba\xbf', b'\xbf\xba\xfe\xca'}


def run(args, **kwargs):
    return subprocess.run([str(arg) for arg in args], cwd=ROOT, check=True, **kwargs)


def check_app(app, version, source, verify_native=True):
    info = plistlib.loads((app / 'Contents/Info.plist').read_bytes())
    if info.get('CFBundleShortVersionString') != version or info.get('CFBundleIdentifier') != 'com.ting.music.demo':
        raise RuntimeError('Built app version or identity does not match the source release')
    resources = app / 'Contents/Resources'
    build = json.loads((resources / 'qq/ting-build-info.json').read_text())
    if set(build) != {'commit', 'clean', 'sourceSha256', 'sourceFileCount', 'resources'}:
        raise RuntimeError('Unexpected build manifest fields')
    for field in ('commit', 'clean', 'sourceSha256', 'sourceFileCount'):
        if build.get(field) != source[field]:
            raise RuntimeError('App was not built from the current clean commit; rebuild before releasing')
    actual_names = {str(file.relative_to(resources)) for group in ('python', 'qq', 'downloader')
                    for file in (resources / group).rglob('*') if file.is_file()}
    if actual_names != set(build['resources']) | {'qq/ting-build-info.json'}:
        raise RuntimeError('Bundled resource files differ from the build manifest')
    for name, digest in build['resources'].items():
        path = resources / name
        if not path.resolve().is_relative_to(resources.resolve()):
            raise RuntimeError('Bundled resources contain an escaping symbolic link')
        with path.open('rb') as stream:
            native = stream.read(4) in MACHO
        if verify_native or not native:
            if hashlib.sha256(path.read_bytes()).hexdigest() != digest:
                raise RuntimeError('Bundled resource hash mismatch: ' + name)
    python = resources / 'python/bin/python3.12'
    lock = json.loads((ROOT / 'scripts/runtime-lock.json').read_text())
    code = ('import platform,sys;assert platform.python_version() == ' + repr(lock['python']) + ';'
            'assert platform.machine() == "arm64";'
            'sys.path.insert(0,' + repr(str(resources / 'qq/vendor')) + ');'
            'sys.path.insert(0,' + repr(str(resources / 'downloader/vendor')) + ');'
            'from qqmusic_api import Client;import requests,mutagen,miniaudio;miniaudio.lib_version()')
    env = {key: value for key, value in os.environ.items() if not key.startswith(('PYTHON', 'DYLD_'))}
    env['PATH'] = '/usr/bin:/bin:/usr/sbin:/sbin'
    run([python, '-I', '-B', '-c', code], env=env)


def sign_ad_hoc(app):
    # Sign nested native extensions first; this avoids stale wheel/runtime signatures.
    for file in sorted(app.rglob('*')):
        if not file.is_file() or file.is_symlink():
            continue
        with file.open('rb') as stream:
            native = stream.read(4) in MACHO
        if native:
            run(['codesign', '--force', '--sign', '-', '--timestamp=none', file], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    run(['codesign', '--force', '--deep', '--sign', '-', '--timestamp=none', app])
    run(['codesign', '--verify', '--deep', '--strict', app])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source-only', action='store_true')
    parser.add_argument('--app', type=Path, default=ROOT / 'src-tauri/target/release/bundle/macos/听 · Ting.app')
    parser.add_argument('--output', type=Path, default=ROOT / 'Release')
    parser.add_argument('--gitleaks', help='path to an installed Gitleaks binary')
    args = parser.parse_args()
    version = json.loads((ROOT / 'package.json').read_text())['version']
    run(['node', 'scripts/check-release.mjs'])
    dirty = subprocess.check_output(['git', 'status', '--porcelain', '--untracked-files=all'], cwd=ROOT, text=True)
    if dirty:
        raise SystemExit('Commit the reviewed source first; release archives require a clean Git checkout.')
    revision = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip()
    source_state = json.loads(subprocess.check_output(['node', 'scripts/source-manifest.mjs', '--json'], cwd=ROOT, text=True))
    scan = [os.sys.executable, '-B', 'scripts/scan-secrets.py', '--history']
    if args.gitleaks:
        scan.extend(['--gitleaks', args.gitleaks])
    run(scan)
    if not args.source_only and (platform.system() != 'Darwin' or platform.machine() != 'arm64'):
        raise SystemExit('App release packaging supports macOS Apple Silicon only.')
    output = args.output.resolve() / f'v{version}'
    if output.exists():
        raise SystemExit('Release destination already exists; choose another --output directory.')
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='.ting-release-', dir=output.parent) as temp:
        stage = Path(temp)
        source_dir = stage / 'Source'
        source_dir.mkdir()
        source = source_dir / f'Ting-v{version}-source.zip'
        run(['git', 'archive', '--format=zip', '--prefix=ting-music/', f'--output={source}', revision])
        artifacts = [source]
        if not args.source_only:
            run(['node', 'scripts/preflight.mjs'])
            platform_dir = stage / 'macOS-AppleSilicon'
            platform_dir.mkdir()
            app = platform_dir / '听 · Ting.app'
            run(['ditto', args.app.resolve(), app])
            check_app(app, version, source_state)
            scanner = args.gitleaks or shutil.which('gitleaks') or str(ROOT / 'work/security-tools/gitleaks')
            run([os.sys.executable, '-B', 'scripts/scan-app.py', app, '--gitleaks', scanner])
            sign_ad_hoc(app)
            check_app(app, version, source_state, verify_native=False)
            archive = platform_dir / f'Ting-v{version}-macOS-AppleSilicon.zip'
            run(['ditto', '-c', '-k', '--sequesterRsrc', '--keepParent', app, archive])
            artifacts.append(archive)
        checksums = {item.relative_to(stage).as_posix(): hashlib.sha256(item.read_bytes()).hexdigest() for item in artifacts}
        (stage / 'SHA256SUMS.txt').write_text(''.join(f'{digest}  {name}\n' for name, digest in checksums.items()))
        (stage / 'release.json').write_text(json.dumps({'version': version, 'commit': revision,
            'platform': 'macOS 15+ / Apple Silicon', 'architecture': 'arm64',
            'minimumSystemVersion': '15.0',
            'appPath': None if args.source_only else 'macOS-AppleSilicon/听 · Ting.app',
            'signing': 'none (source only)' if args.source_only else 'ad-hoc; not notarized',
            'sha256': checksums}, indent=2) + '\n')
        stage.rename(output)
    print(f'Local release archives verified: {output}')


if __name__ == '__main__':
    main()
