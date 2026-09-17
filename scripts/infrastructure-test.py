"""Meaningful release-preparation failure-path checks; never performs a download."""
import importlib.util
import io
import json
from pathlib import Path
import plistlib
import tarfile
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('prepare_runtime', ROOT / 'scripts/prepare-runtime.py')
runtime = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runtime)
release_spec = importlib.util.spec_from_file_location('release', ROOT / 'scripts/release.py')
release = importlib.util.module_from_spec(release_spec)
release_spec.loader.exec_module(release)


class RuntimeArchives(unittest.TestCase):
    def extract(self, name, link=None):
        with tempfile.TemporaryDirectory() as temp:
            archive = Path(temp) / 'runtime.tar.gz'
            with tarfile.open(archive, 'w:gz') as stream:
                member = tarfile.TarInfo(name)
                if link:
                    member.type = tarfile.SYMTYPE
                    member.linkname = link
                    stream.addfile(member)
                else:
                    member.size = 4
                    stream.addfile(member, io.BytesIO(b'test'))
            runtime.safe_extract(archive, Path(temp) / 'out')

    def test_rejects_traversal(self):
        with self.assertRaisesRegex(RuntimeError, 'Unsafe'):
            self.extract('python/../../outside')

    def test_rejects_escaping_symlink(self):
        with self.assertRaisesRegex(RuntimeError, 'escaping'):
            self.extract('python/bin/python3', '../../../outside')

    def test_rejects_absolute_symlink(self):
        with self.assertRaisesRegex(RuntimeError, 'escaping'):
            self.extract('python/bin/python3', '/usr/bin/python3')

    def test_accepts_runtime_local_link(self):
        self.extract('python/bin/python3', 'python3.12')

    def test_rejects_stale_runtime_marker_before_execution(self):
        with tempfile.TemporaryDirectory() as temp:
            with self.assertRaisesRegex(RuntimeError, 'absent or stale'):
                runtime.verify(Path(temp), {'python': '3.12.14'})


class ReleaseProvenance(unittest.TestCase):
    def fixture(self, folder):
        app = Path(folder) / 'Ting.app'
        (app / 'Contents/Resources/qq').mkdir(parents=True)
        (app / 'Contents/Info.plist').write_bytes(plistlib.dumps({
            'CFBundleShortVersionString': '0.8.0', 'CFBundleIdentifier': 'com.ting.music.demo'}))
        state = {'commit': '1' * 40, 'clean': True, 'sourceSha256': '2' * 64, 'sourceFileCount': 1}
        marker = app / 'Contents/Resources/qq/ting-build-info.json'
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
            (app / 'Contents/Resources/qq/unexpected.txt').write_text('unexpected')
            with self.assertRaisesRegex(RuntimeError, 'differ from the build manifest'):
                release.check_app(app, '0.8.0', state)


if __name__ == '__main__':
    unittest.main()
