#!/usr/bin/env python3
"""Prepare hash-locked Python dependencies, without changing the global Python install."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]
LOCK = ROOT / 'scripts/dependencies-lock.json'
GROUPS = ('qq', 'downloader')


def patch_qq(vendor):
    policy = vendor / 'qqmusic_api/core/versioning.py'
    text = policy.read_text()
    for uin in ('credential.musicid or None', 'credential.musicid'):
        needle = f'                uin={uin},\n'
        replacement = needle + ('                authst=credential.musickey or None,\n'
                                '                tmeLoginType=credential.login_type or None,\n')
        if replacement not in text:
            if needle not in text:
                raise RuntimeError('Unexpected QQMusicApi version; authentication patch not applied')
            text = text.replace(needle, replacement)
    if text.count('authst=credential.musickey or None') != 3:
        raise RuntimeError('Unexpected QQMusicApi authentication policy')
    policy.write_text(text)


def verify(group, vendor):
    if group == 'qq':
        policy = vendor / 'qqmusic_api/core/versioning.py'
        if not policy.is_file() or policy.read_text().count('authst=credential.musickey or None') != 3:
            raise RuntimeError('QQ authentication patch missing; rerun resource preparation')
    imports = {'qq': 'from qqmusic_api import Client; import pydantic_core, orjson',
               'downloader': 'import requests, mutagen, miniaudio; miniaudio.lib_version()'}
    code = f'import sys;sys.path.insert(0,{str(vendor)!r});' + imports[group]
    subprocess.run([sys.executable, '-I', '-B', '-c', code], check=True)


def expected_manifest(group):
    return {'python': '3.12', 'platform': sys.platform,
            'machine': __import__('platform').machine(),
            'requirements_sha256': hashlib.sha256((ROOT / 'resources' / group / 'requirements.txt').read_bytes()).hexdigest(),
            'lock_sha256': hashlib.sha256(LOCK.read_bytes()).hexdigest(), 'patch_version': 1}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--check', action='store_true', help='verify prepared bundles without installing')
    args = parser.parse_args()
    bundled = ROOT / 'resources/python/bin/python3.12'
    if sys.version_info[:2] != (3, 12):
        if bundled.exists():
            os.execv(str(bundled), [str(bundled), '-I', '-B', str(Path(__file__).resolve()), *sys.argv[1:]])
        raise SystemExit('Prepare the bundled runtime first: python3 scripts/prepare-runtime.py')
    locked = json.loads(LOCK.read_text())['packages']
    for group in GROUPS:
        folder = ROOT / 'resources' / group
        vendor = folder / 'vendor'
        manifest = expected_manifest(group)
        if args.check:
            marker = vendor / '.ting-resources.json'
            if not marker.exists() or json.loads(marker.read_text()) != manifest:
                raise RuntimeError(f'{group} resources are absent or stale; run scripts/prepare-resources.py')
            verify(group, vendor)
            continue
        with tempfile.TemporaryDirectory(prefix=f'ting-{group}-', dir=folder) as temp:
            stage = Path(temp) / 'vendor'
            requirements = Path(temp) / 'requirements.txt'
            specs = [line.strip() for line in (folder / 'requirements.txt').read_text().splitlines()
                     if line.strip() and not line.startswith('#')]
            requirements.write_text('\n'.join(spec + ''.join(' \\\n    --hash=sha256:' + value for value in locked[spec]) for spec in specs) + '\n')
            subprocess.run([sys.executable, '-I', '-B', '-m', 'pip', 'install', '--disable-pip-version-check',
                            '--no-compile', '--no-deps', '--only-binary=:all:', '--require-hashes',
                            '--index-url', 'https://pypi.org/simple', '--target', str(stage),
                            '-r', str(requirements)], check=True)
            if group == 'qq':
                patch_qq(stage)
            verify(group, stage)
            (stage / '.ting-resources.json').write_text(json.dumps(manifest, indent=2) + '\n')
            previous = Path(temp) / 'previous'
            if vendor.exists():
                vendor.rename(previous)
            try:
                stage.rename(vendor)
            except BaseException:
                if previous.exists():
                    previous.rename(vendor)
                raise
    print('Verified hash-locked Python resources and QQ membership authentication patch.')


if __name__ == '__main__':
    main()
