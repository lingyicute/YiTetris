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


def font_span(html):
    # Keep the same fixture assertions usable against the upstream regex API.
    if hasattr(font, 'font_face_span'):
        return font.font_face_span(html)
    match = font.FONT_FACE_RE.search(html)
    if not match:
        raise ValueError('No font face')
    return match.span()


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
        html = '<style>' + other + FACE + '</style>'
        start, end = font_span(html)
        self.assertEqual(html[:start] + 'NEW' + html[end:], '<style>' + other + 'NEW</style>')

    def test_generated_comment_does_not_accumulate(self):
        face = font.make_font_face('AAAA', 1, 2, 3, 'test', 1024)
        html = '<style>' + face + '</style>'
        start, end = font_span(html)
        self.assertEqual(html[:start] + face + html[end:], html)

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

    def test_atomic_write_follows_symlink_without_replacing_it(self):
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / 'real.html'
            target.write_text('old')
            link = Path(tmp) / 'index.html'
            link.symlink_to(target.name)
            font.atomic_write(link, 'new')
            self.assertTrue(link.is_symlink())
            self.assertEqual(target.read_text(), 'new')

    def test_font_is_closed_even_if_subsetting_fails(self):
        from types import SimpleNamespace
        from unittest.mock import Mock
        face = Mock()
        subsetter = Mock()
        subsetter.subset.side_effect = RuntimeError('subset failed')
        modules = {
            'fontTools': SimpleNamespace(),
            'fontTools.ttLib': SimpleNamespace(TTFont=Mock(return_value=face)),
            'fontTools.subset': SimpleNamespace(Subsetter=Mock(return_value=subsetter), Options=Mock()),
        }
        with patch.dict('sys.modules', modules):
            with self.assertRaises(RuntimeError):
                font.build_subset({'A'}, 'font.woff2')
        face.close.assert_called_once()

    def test_cli_ignores_font_face_text_in_scripts_and_html_comments(self):
        with tempfile.TemporaryDirectory() as tmp:
            path, argv = self.run_cli(tmp)
            prefix = '<script>const css = "' + FACE + '";</script><!--<style>' + FACE + '</style>-->'
            path.write_text(prefix + '<style>' + FACE + '</style>')
            with patch('sys.argv', argv), patch.object(font, 'HERE', tmp), \
                 patch.object(font, 'build_subset', return_value=(b'woff', set())), \
                 contextlib.redirect_stdout(io.StringIO()):
                font.main()
            result = path.read_text()
            self.assertTrue(result.startswith(prefix))
            self.assertIn('data:font/woff2', result[len(prefix):])

    def test_cli_does_not_replace_a_font_named_only_inside_a_css_comment(self):
        with tempfile.TemporaryDirectory() as tmp:
            path, argv = self.run_cli(tmp)
            other = "@font-face { /* font-family: 'Nebulove'; */ font-family: 'Other'; src: url(other); }"
            path.write_text('<style>' + other + FACE + '</style>')
            with patch('sys.argv', argv), patch.object(font, 'HERE', tmp), \
                 patch.object(font, 'build_subset', return_value=(b'woff', set())), \
                 contextlib.redirect_stdout(io.StringIO()):
                font.main()
            self.assertIn(other, path.read_text())

    def test_cli_rejects_ambiguous_multiple_nebulove_faces_before_building(self):
        with tempfile.TemporaryDirectory() as tmp:
            path, argv = self.run_cli(tmp)
            source = '<style>' + FACE + FACE + '</style>'
            path.write_text(source)
            with patch('sys.argv', argv), patch.object(font, 'HERE', tmp), \
                 patch.object(font, 'build_subset', return_value=(b'woff', set())) as build, \
                 contextlib.redirect_stdout(io.StringIO()):
                with self.assertRaises(SystemExit):
                    font.main()
            build.assert_not_called()
            self.assertEqual(path.read_text(), source)
            self.assertFalse((Path(tmp) / 'Nebulove-subset.woff2').exists())

    def test_font_scanner_preserves_quoted_css_delimiters(self):
        other = '@font-face { src: url("x; font-family: Nebulove; }"); font-family: Other; }'
        face = '@font-face { src: url("x}y"); font-family: "Nebulove" }'
        html = '<style>' + other + face + '</style>'
        start, end = font_span(html)
        self.assertEqual(html[start:end], face)

    def test_font_scanner_offsets_follow_htmlparser_line_counting(self):
        for sep in ('\r', '\r\n', '\u2028'):
            html = '<p>text' + sep + 'text</p>\n<style>' + FACE + '</style>'
            start, end = font_span(html)
            self.assertEqual(html[start:end], FACE)

    def test_font_scanner_accepts_empty_css_type_and_ignores_other_types(self):
        html = '<style type="text/plain">' + FACE + '</style><style type>' + FACE + '</style>'
        start, end = font_span(html)
        self.assertEqual(html[:start], '<style type="text/plain">' + FACE + '</style><style type>')
        self.assertEqual(html[start:end], FACE)

    def test_font_scanner_ignores_style_examples_in_textarea(self):
        prefix = '<textarea><style>' + FACE + '</style></textarea>'
        html = prefix + '<style>' + FACE + '</style>'
        start, end = font_span(html)
        self.assertEqual(html[:start], prefix + '<style>')
        self.assertEqual(html[start:end], FACE)


if __name__ == '__main__':
    unittest.main()
