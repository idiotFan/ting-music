#!/usr/bin/env python3
"""Refresh PyPI artifact hashes for the exact versions already pinned in requirements.txt."""
from concurrent.futures import ThreadPoolExecutor
import json
from pathlib import Path
import re
import urllib.request

ROOT = Path(__file__).resolve().parents[1]


def fetch(spec):
    if not re.fullmatch(r'[A-Za-z0-9_.-]+==[A-Za-z0-9_.+-]+', spec):
        raise RuntimeError('Requirements must use exact versions: ' + spec)
    name, version = spec.split('==')
    with urllib.request.urlopen(f'https://pypi.org/pypi/{name}/{version}/json', timeout=45) as response:
        metadata = json.load(response)
    hashes = sorted({item['digests']['sha256'] for item in metadata['urls']})
    if not hashes:
        raise RuntimeError('PyPI returned no artifact hashes for ' + spec)
    return spec, hashes


def main():
    specs = {line.strip() for group in ('qq', 'downloader')
             for line in (ROOT / 'resources' / group / 'requirements.txt').read_text().splitlines()
             if line.strip() and not line.startswith('#')}
    with ThreadPoolExecutor(max_workers=6) as executor:
        packages = dict(sorted(executor.map(fetch, specs)))
    lock = {'source': 'https://pypi.org', 'packages': packages}
    (ROOT / 'scripts/dependencies-lock.json').write_text(json.dumps(lock, indent=2) + '\n')
    print(f'Locked official PyPI hashes for {len(packages)} exact package versions. Review the diff and rerun resource preparation and tests.')


if __name__ == '__main__':
    main()
