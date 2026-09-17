#!/usr/bin/env python3
"""Install a relocatable, hash-verified CPython runtime for macOS Apple Silicon."""
import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import platform
import subprocess
import tarfile
import tempfile
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
LOCK = ROOT / 'scripts/runtime-lock.json'


def verify(runtime, lock):
    marker = runtime / '.ting-runtime.json'
    if not marker.is_file() or json.loads(marker.read_text()) != lock:
        raise RuntimeError('Runtime is absent or stale; run python3 scripts/prepare-runtime.py')
    executable = runtime / 'bin/python3.12'
    code = 'import json,platform,ssl,sys;print(json.dumps([platform.python_version(),platform.machine(),ssl.OPENSSL_VERSION]))'
    info = json.loads(subprocess.check_output([str(executable), '-I', '-B', '-c', code], text=True))
    if info[0] != lock['python'] or info[1] != 'arm64':
        raise RuntimeError('Bundled runtime version or architecture does not match the release lock')


def safe_extract(archive, destination):
    with tarfile.open(archive, 'r:gz') as tar:
        members = tar.getmembers()
        for member in members:
            path = PurePosixPath(member.name)
            if path.is_absolute() or '..' in path.parts or path.parts[0] != 'python':
                raise RuntimeError('Unsafe runtime archive path')
            if not (member.isfile() or member.isdir() or member.issym() or member.islnk()):
                raise RuntimeError('Unexpected runtime archive entry')
            if member.issym() or member.islnk():
                target = PurePosixPath(member.linkname)
                base = path.parent if member.issym() else PurePosixPath()
                combined = os.path.normpath(str(base / target))
                if target.is_absolute() or not (combined == 'python' or combined.startswith('python/')):
                    raise RuntimeError('Runtime archive contains an escaping link')
        options = {'filter': 'data'} if hasattr(tarfile, 'data_filter') else {}
        tar.extractall(destination, members=members, **options)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--check', action='store_true', help='validate existing runtime without downloading')
    args = parser.parse_args()
    if platform.system() != 'Darwin' or platform.machine() != 'arm64':
        raise SystemExit('Release builds currently support macOS Apple Silicon only.')
    lock = json.loads(LOCK.read_text())
    runtime = ROOT / 'resources/python'
    if args.check:
        verify(runtime, lock)
        print('Bundled CPython runtime verified.')
        return
    if runtime.exists():
        try:
            verify(runtime, lock)
            print('Bundled CPython runtime is already current.')
            return
        except (RuntimeError, subprocess.CalledProcessError):
            pass
    (ROOT / 'work').mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='runtime-', dir=ROOT / 'work') as temp:
        temp = Path(temp)
        archive = temp / 'runtime.tar.gz'
        request = urllib.request.Request(lock['url'], headers={'User-Agent': 'Ting-runtime-bootstrap'})
        digest = hashlib.sha256()
        received = 0
        with urllib.request.urlopen(request, timeout=60) as response, archive.open('wb') as output:
            while chunk := response.read(1024 * 1024):
                received += len(chunk)
                if received > lock['size']:
                    raise RuntimeError('Runtime download exceeds locked size')
                digest.update(chunk)
                output.write(chunk)
        if received != lock['size'] or digest.hexdigest() != lock['sha256']:
            raise RuntimeError('Runtime download SHA256 or size mismatch; refusing to extract')
        safe_extract(archive, temp)
        stage = temp / 'python'
        (stage / '.ting-runtime.json').write_text(json.dumps(lock, indent=2) + '\n')
        verify(stage, lock)
        previous = temp / 'previous'
        if runtime.exists():
            runtime.rename(previous)
        try:
            stage.rename(runtime)
        except BaseException:
            if previous.exists():
                previous.rename(runtime)
            raise
    verify(runtime, lock)
    print('Installed verified, relocatable CPython runtime for macOS Apple Silicon.')


if __name__ == '__main__':
    main()
