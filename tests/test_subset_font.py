import contextlib
import importlib.util
import io
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

SCRIPT = Path(os.environ.get('YT_FONT_SCRIPT', Path(__file__).parents[1] / 'scripts/subset_font.py'))
spec = importlib.util.spec_from_file_location('subset_font', SCRIPT)
font = importlib.util.module_from_spec(spec)
spec.loader.exec_module(font)
FACE = "@font-face { font-family: 'Nebulove'; src: url(old); }"


class FontTests(unittest.TestCase):
    def test_entities_are_collected_in_both_modes(self):
        for all_text in (False, True):
            self.assertIn('梨', font.collect_chars('<p>&#x68A8;</p>', all_text=all_text))

    def test_comment_delimiters_inside_ui_strings_are_not_stripped(self):
        text = '<script>toast("/* 梨 */"); toast("<!-- 鱼 -->");</script>'
        self.assertTrue(set('梨鱼') <= font.collect_chars(text))

    def test_non_rendering_html_and_css_are_omitted(self):
        chars = font.collect_chars('<!-- 鱼 --><style>/* 鸟 */</style><p>梨</p>')
        self.assertIn('梨', chars)
        self.assertNotIn('鱼', chars)
        self.assertNotIn('鸟', chars)

    def test_extras_ascii_and_punctuation_are_retained(self):
        chars = font.collect_chars('', extra='梨\n')
        self.assertTrue(set('梨0123456789：') <= chars)
        self.assertNotIn('\n', chars)

    def test_only_nebulove_is_replaced(self):
        other = '@font-face { font-family: "Other"; src: url(other); }'
        result = font.FONT_FACE_RE.sub('NEW', other + FACE)
        self.assertEqual(result, other + 'NEW')

    def test_generated_comment_does_not_accumulate(self):
        face = font.make_font_face('AAAA', 1, 2, 3, 'test', 1024)
        html = '<style>' + face + '</style>'
        self.assertEqual(font.FONT_FACE_RE.sub(lambda m: face, html), html)

    def run_cli(self, directory, check=False, download=False):
        path = Path(directory) / 'index.html'
        path.write_text('<style>' + FACE + '</style><p>梨</p>', encoding='utf-8')
        local = Path(directory) / 'full.woff2'
        local.write_bytes(b'font')
        argv = ['subset_font.py', '--html', str(path)]
        if not download:
            argv += ['--ttf', str(local)]
        if check:
            argv += ['--check']
        return path, argv

    def test_check_does_not_modify_page_or_emit_subset(self):
        with tempfile.TemporaryDirectory() as tmp:
            path, argv = self.run_cli(tmp, check=True)
            original = path.read_bytes()
            with patch('sys.argv', argv), patch.object(font, 'HERE', tmp), \
                 patch.object(font, 'build_subset', return_value=(b'woff', {ord('梨')})), \
                 contextlib.redirect_stdout(io.StringIO()):
                font.main()
            self.assertEqual(path.read_bytes(), original)
            self.assertFalse((Path(tmp) / 'Nebulove-subset.woff2').exists())

    def test_download_uses_private_temporary_path_and_cleans_up(self):
        with tempfile.TemporaryDirectory() as tmp:
            path, argv = self.run_cli(tmp, check=True, download=True)
            downloaded = []

            def fake_download(url, destination):
                downloaded.append(destination)
                Path(destination).write_bytes(b'font')

            with patch('sys.argv', argv), patch.object(font, 'download', side_effect=fake_download), \
                 patch.object(font, 'build_subset', return_value=(b'woff', set())), \
                 contextlib.redirect_stdout(io.StringIO()):
                font.main()
            self.assertNotEqual(downloaded[0], '/tmp/Nebulove.woff2')
            self.assertFalse(Path(downloaded[0]).exists())

    def test_atomic_write_preserves_mode(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'index.html'
            path.write_text('old')
            path.chmod(0o640)
            font.atomic_write(path, '新')
            self.assertEqual(path.read_text(), '新')
            self.assertEqual(path.stat().st_mode & 0o777, 0o640)
            self.assertEqual(list(Path(tmp).iterdir()), [path])

    def test_failed_atomic_replace_preserves_source_and_removes_temp(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'index.html'
            path.write_text('old')
            with patch.object(font.os, 'replace', side_effect=OSError('simulated failure')):
                with self.assertRaises(OSError):
                    font.atomic_write(path, 'new')
            self.assertEqual(path.read_text(), 'old')
            self.assertEqual(list(Path(tmp).iterdir()), [path])


if __name__ == '__main__':
    unittest.main()
