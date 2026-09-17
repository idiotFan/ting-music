#!/usr/bin/env python3
"""Scan a packaged app, allowing only byte-verified upstream false positives."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]
# Each file was independently checked byte-for-byte against its hash-locked PyPI wheel.
PUBLIC_MATCHES = {
    'qq/vendor/cryptography/hazmat/bindings/_rust/openssl/hpke.pyi': (
        'a7f8462e7e981fe11aac91755796d4b14b638a9be2100a5c4793b4b141c92ed7', 'generic-api-key', {(77, 77), (101, 101)}),
    'qq/vendor/qh3/quic/configuration.py': (
        '24543569eb120e7696c27ef174ab3434b65245304616c339653365c75dc9edab', 'private-key', {(220, 222)}),
    'qq/vendor/qqmusic_api/utils/qimei.py': (
        '09331eddb65ea5b5d862260727cefc40d2779d5d337ee6bc26f4b424f8c9e407', 'generic-api-key', {(30, 30)}),
}


def known_public_match(finding, resources):
    path = Path(finding['File']).resolve()
    try:
        name = str(path.relative_to(resources.resolve()))
    except ValueError:
        return False
    bounds = (finding['StartLine'], finding['EndLine'])
    if name in PUBLIC_MATCHES:
        digest, rule, lines = PUBLIC_MATCHES[name]
        return (finding['RuleID'] == rule and bounds in lines
                and hashlib.sha256(path.read_bytes()).hexdigest() == digest)
    if name == 'qq/ting-build-info.json' and finding['RuleID'] == 'generic-api-key' and bounds[0] == bounds[1]:
        line = path.read_text().splitlines()[bounds[0] - 1]
        return re.fullmatch(r'\s*"[^"\\]+": "[a-f0-9]{64}",?\s*', line) is not None
    return False


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('app', type=Path)
    parser.add_argument('--gitleaks', default=os.environ.get('GITLEAKS_BIN'))
    args = parser.parse_args()
    scanner = args.gitleaks or shutil.which('gitleaks') or str(ROOT / 'work/security-tools/gitleaks')
    app = args.app.resolve()
    resources = app / 'Contents/Resources'
    (ROOT / 'work').mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='app-scan-', dir=ROOT / 'work') as temp:
        report = Path(temp) / 'redacted-report.json'
        result = subprocess.run([scanner, 'dir', '--redact', '--no-banner', '--report-format', 'json',
                                 '--report-path', str(report), str(app)], cwd=ROOT, capture_output=True, text=True)
        if result.returncode not in (0, 1) or not report.is_file():
            raise RuntimeError('App credential scanner failed: ' + result.stderr[-1500:])
        findings = json.loads(report.read_text())
        unexpected = [item for item in findings if not known_public_match(item, resources)]
        if unexpected:
            for item in unexpected:
                print(f"Unreviewed credential pattern: {item['File']}:{item['StartLine']} ({item['RuleID']})")
            raise SystemExit('App credential scan failed; no secret values were printed.')
    print(f'App credential scan passed; {len(findings)} matches were verified public source patterns or SHA256 metadata.')


if __name__ == '__main__':
    main()
