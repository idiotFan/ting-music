"""Meaningful release-preparation failure-path checks; never performs a download."""
import importlib.util
import io
import json
import hashlib
from pathlib import Path
import plistlib
import shutil
import sys
import tarfile
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
release_spec = importlib.util.spec_from_file_location('release', ROOT / 'scripts/release.py')
release = importlib.util.module_from_spec(release_spec)
release_spec.loader.exec_module(release)


class ReleaseProvenance(unittest.TestCase):
    def fixture(self, folder):
        app = Path(folder) / 'Ting.app'
        (app / 'Contents/Resources/build').mkdir(parents=True)
        (app / 'Contents/Info.plist').write_bytes(plistlib.dumps({
            'CFBundleShortVersionString': '0.8.0', 'CFBundleIdentifier': 'com.ting.music.demo'}))
        state = {'commit': '1' * 40, 'clean': True, 'sourceSha256': '2' * 64, 'sourceFileCount': 1}
        marker = app / 'Contents/Resources/build/ting-build-info.json'
        marker.write_text(json.dumps({**state, 'resources': {}}))
        return app, state, marker

    def test_rejects_wrong_app_version_before_execution(self):
        with tempfile.TemporaryDirectory() as temp:
            app, state, _ = self.fixture(temp)
            with self.assertRaisesRegex(RuntimeError, 'version or identity'):
                release.check_app(app, '0.8.1', state)

    def test_rejects_same_version_old_commit(self):
        with tempfile.TemporaryDirectory() as temp:
            app, state, _ = self.fixture(temp)
            state['commit'] = '3' * 40
            with self.assertRaisesRegex(RuntimeError, 'current clean commit'):
                release.check_app(app, '0.8.0', state)

    def test_rejects_unlisted_resource_file(self):
        with tempfile.TemporaryDirectory() as temp:
            app, state, _ = self.fixture(temp)
            (app / 'Contents/Resources/build/unexpected.txt').write_text('unexpected')
            with self.assertRaisesRegex(RuntimeError, 'differ from the build manifest'):
                release.check_app(app, '0.8.0', state)


class ReleaseLayout(unittest.TestCase):
    def package(self, root, source_only=False):
        (root / 'package.json').write_text(json.dumps({'version': '0.8.0'}))
        built_app = root / 'built.app'
        built_app.mkdir(exist_ok=True)
        (built_app / 'fixture.txt').write_text('built application')
        state = {'commit': '1' * 40, 'clean': True, 'sourceSha256': '2' * 64, 'sourceFileCount': 1}

        def checked_output(command, **kwargs):
            if command[:2] == ['git', 'status']:
                return ''
            if command[:2] == ['git', 'rev-parse']:
                return state['commit']
            return json.dumps(state)

        def run(command, **kwargs):
            command = [str(arg) for arg in command]
            if command[:2] == ['git', 'archive']:
                Path(next(arg[9:] for arg in command if arg.startswith('--output='))).write_bytes(b'source archive')
            elif command[:2] == ['ditto', '-c']:
                Path(command[-1]).write_bytes(b'application archive')
            elif command[0] == 'ditto':
                shutil.copytree(command[1], command[2])

        arguments = ['release.py', '--app', str(built_app)] + (['--source-only'] if source_only else [])
        with patch.object(release, 'ROOT', root), patch.object(sys, 'argv', arguments), \
             patch.object(release.subprocess, 'check_output', side_effect=checked_output), \
             patch.object(release, 'run', side_effect=run), \
             patch.object(release, 'check_app'), \
             patch.object(release, 'sign_ad_hoc', side_effect=lambda app: (app / 'signature-verified').write_text('verified')), \
             patch.object(release.platform, 'system', return_value='Darwin'), \
             patch.object(release.platform, 'machine', return_value='arm64'):
            release.main()
        return root / 'Release/v0.8.0'

    def test_platform_layout_retains_verified_app_and_relative_checksums(self):
        with tempfile.TemporaryDirectory() as temp:
            output = self.package(Path(temp))
            self.assertTrue((output / 'macOS-AppleSilicon/听 · Ting.app/signature-verified').is_file())
            manifest = json.loads((output / 'release.json').read_text())
            self.assertEqual(manifest['platform'], 'macOS 15+ / Apple Silicon')
            self.assertEqual(manifest['appPath'], 'macOS-AppleSilicon/听 · Ting.app')
            self.assertEqual(set(manifest['sha256']), {
                'Source/Ting-v0.8.0-source.zip',
                'macOS-AppleSilicon/Ting-v0.8.0-macOS-AppleSilicon.zip'})
            for name, digest in manifest['sha256'].items():
                self.assertEqual(hashlib.sha256((output / name).read_bytes()).hexdigest(), digest)
                self.assertIn(f'{digest}  {name}\n', (output / 'SHA256SUMS.txt').read_text())

    def test_source_only_uses_same_version_directory_and_preserves_existing_output(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            output = self.package(root, source_only=True)
            source = output / 'Source/Ting-v0.8.0-source.zip'
            self.assertTrue(source.is_file())
            self.assertFalse((output / 'macOS-AppleSilicon').exists())
            self.assertIsNone(json.loads((output / 'release.json').read_text())['appPath'])
            source.write_bytes(b'keep existing output')
            with self.assertRaisesRegex(SystemExit, 'already exists'):
                self.package(root, source_only=True)
            self.assertEqual(source.read_bytes(), b'keep existing output')

if __name__ == '__main__':
    unittest.main()
