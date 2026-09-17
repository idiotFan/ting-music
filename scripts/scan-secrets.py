#!/usr/bin/env python3
"""Scan only files eligible for Git; never scan the user's ignored local data."""
import argparse
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--gitleaks', default=os.environ.get('GITLEAKS_BIN'))
    parser.add_argument('--history', action='store_true', help='also scan every reachable Git commit')
    args = parser.parse_args()
    binary = args.gitleaks or shutil.which('gitleaks') or str(ROOT / 'work/security-tools/gitleaks')
    if not Path(binary).is_file():
        raise SystemExit('Install Gitleaks from https://github.com/gitleaks/gitleaks or pass --gitleaks PATH.')
    subprocess.run(['node', str(ROOT / 'scripts/check-release.mjs')], cwd=ROOT, check=True)
    files = sorted(set(subprocess.check_output(['git', 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], cwd=ROOT).decode().strip('\0').split('\0')))
    (ROOT / 'work').mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='security-snapshot-', dir=ROOT / 'work') as temp:
        snapshot = Path(temp)
        for name in files:
            source = ROOT / name
            if source.is_symlink() or not source.is_file():
                raise SystemExit('Refusing non-regular source entry: ' + name)
            target = snapshot / name
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source, target)
        subprocess.run([binary, 'dir', '--redact', '--no-banner', str(snapshot)], check=True, cwd=ROOT)
    if args.history:
        subprocess.run([binary, 'git', '--redact', '--no-banner', '--log-opts=--all', str(ROOT)], check=True, cwd=ROOT)
    print(f'Secret scan passed for {len(files)} Git candidate files' + (' and Git history.' if args.history else '.'))


if __name__ == '__main__':
    main()
