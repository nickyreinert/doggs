"""Office preview cache, conversion bounds, and process failure regressions."""
import subprocess
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

import pymupdf as fitz
from previews import OfficePreviews


class OfficePreviewTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='doggs-preview-tests-')
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.source = self.root / 'original.pptx'
        self.source.write_bytes(b'Original presentation bytes')
        self.renderer = OfficePreviews(self.root / 'cache', executable='/fake/soffice', max_pending=1)
        self.addCleanup(self.renderer.worker.shutdown, wait=True)

    def converter(self, command, **kwargs):
        directory = Path(command[command.index('--outdir') + 1])
        self.assertNotEqual(Path(command[-1]), self.source)
        self.assertEqual(Path(command[-1]).read_bytes(), self.source.read_bytes())
        profile = next(arg for arg in command if arg.startswith('-env:UserInstallation='))
        self.assertIn('profile', profile)
        with fitz.open() as doc:
            doc.new_page().insert_text((72, 72), 'Rendered slide')
            doc.save(directory / 'document.pdf')
        return Mock(pid=12345, returncode=0, communicate=Mock(return_value=(b'', b'')))

    def test_conversion_preserves_source_and_reuses_pdf(self):
        with patch('previews.subprocess.Popen', side_effect=self.converter) as convert:
            self.assertEqual(self.renderer.request(self.source)[0], 'queued')
            self.renderer.worker.shutdown(wait=True)
            state, output = self.renderer.request(self.source)
            self.assertEqual(state, 'ready')
            self.assertEqual(convert.call_count, 1)
            self.assertEqual(self.source.read_bytes(), b'Original presentation bytes')
            with fitz.open(output) as doc:
                self.assertIn('Rendered slide', doc[0].get_text())
            self.assertFalse(list(self.root.glob('.~lock*')))

    def test_missing_renderer_leaves_text_fallback_available(self):
        self.renderer.executable = None
        self.assertEqual(self.renderer.request(self.source), ('unavailable', None))

    def test_queue_is_bounded_and_duplicate_requests_share_a_job(self):
        release = threading.Event()
        process = Mock(pid=12345, returncode=1)
        process.communicate.side_effect = lambda **kwargs: release.wait(timeout=5)
        second = self.root / 'second.pptx'
        second.write_bytes(b'Second presentation')
        try:
            with patch('previews.subprocess.Popen', return_value=process) as convert:
                self.assertEqual(self.renderer.request(self.source)[0], 'queued')
                self.assertIn(self.renderer.request(self.source)[0], {'queued', 'rendering'})
                self.assertEqual(self.renderer.request(second), ('busy', None))
                release.set()
                self.renderer.worker.shutdown(wait=True)
                self.assertEqual(convert.call_count, 1)
        finally:
            release.set()

    def test_timeout_kills_the_process_group_and_falls_back(self):
        process = Mock(pid=12345, returncode=-9)
        process.communicate.side_effect = [subprocess.TimeoutExpired('soffice', 90), (b'', b'')]
        with patch('previews.subprocess.Popen', return_value=process), patch('previews.os.killpg') as kill:
            self.renderer.request(self.source)
            self.renderer.worker.shutdown(wait=True)
            self.assertEqual(self.renderer.request(self.source), ('failed', None))
            kill.assert_called_once()
            self.assertEqual(kill.call_args.args[0], 12345)
            self.assertIsNone(self.renderer.cached(self.source))

    def test_source_change_invalidates_cached_pdf(self):
        old = self.renderer.cache_path(self.source)
        old.parent.mkdir(parents=True)
        old.write_bytes(b'cached PDF')
        self.assertEqual(self.renderer.cached(self.source), old)
        self.source.write_bytes(b'Changed presentation with a different size')
        self.assertIsNone(self.renderer.cached(self.source))

    def test_deleted_cached_pdf_can_be_rendered_again(self):
        with patch('previews.subprocess.Popen', side_effect=self.converter) as convert:
            self.renderer.request(self.source)
            self.renderer.worker.submit(lambda: None).result(timeout=5)
            self.renderer.cached(self.source).unlink()
            self.assertEqual(self.renderer.request(self.source)[0], 'queued')
            self.renderer.worker.submit(lambda: None).result(timeout=5)
            self.assertEqual(self.renderer.request(self.source)[0], 'ready')
            self.assertEqual(convert.call_count, 2)


if __name__ == '__main__':
    unittest.main()
