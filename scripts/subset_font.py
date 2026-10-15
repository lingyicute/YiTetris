#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Nebulove 字体子集化 & 内嵌

  pip install fonttools brotli
  
  python3 scripts/subset_font.py                     # 就地
  python3 scripts/subset_font.py --check             # 只报告，不写入
  python3 scripts/subset_font.py --all-text          # 保守模式：文件里出现的字符全收
  python3 scripts/subset_font.py --extra-chars glyphs.txt
"""
import argparse, base64, io, os, re, sys, tempfile, urllib.request
from html import unescape
from html.parser import HTMLParser
FONT_URL = "https://raw.githubusercontent.com/lingyicute/Nebulove/main/Nebulove.woff2"
HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_HTML = os.path.join(os.path.dirname(HERE), "index.html")
ASCII = {chr(c) for c in range(32, 127)}
PUNCT = set("：，。！？；‘’“”（）【】—…·《》×＝÷＋－、")

# 连同上一次生成的注释头一起匹配，避免重复运行时注释不断堆叠
_GEN_COMMENT = r'/\*\s*=====\s*Nebulove[^*]*(?:\*(?!/)[^*]*)*\*/'
# Mask CSS comments/strings without changing offsets. Unlike a global regex,
# this keeps quoted delimiters and commented-out declarations out of structure.
_CSS_TOKEN_RE = re.compile(r"/\*.*?(?:\*/|$)|\"(?:\\.|[^\"\\])*\"|'(?:\\.|[^'\\])*'", re.S)
_FONT_START_RE = re.compile(r'@font-face\s*\{', re.I)
_FAMILY_RE = re.compile(r"(?:Nebulove|'Nebulove'|\"Nebulove\")", re.I)


class StyleParser(HTMLParser):
    """Record actual inline stylesheet offsets, never JS strings/HTML comments."""
    CDATA_CONTENT_ELEMENTS = (
        "script", "style", "textarea", "title", "xmp", "iframe", "noembed", "noframes", "noscript"
    )

    def __init__(self, html):
        super().__init__(convert_charrefs=False)
        # HTMLParser counts only LF as a line break (not all splitlines chars).
        self.offsets = [0] + [m.end() for m in re.finditer('\n', html)]
        self.in_style = False
        self.styles = []
        self.feed(html)
        self.close()

    def handle_starttag(self, tag, attrs):
        if tag == 'style':
            attributes = dict(attrs)
            self.in_style = (attributes.get('type') or 'text/css').strip().lower() in ('', 'text/css')

    def handle_endtag(self, tag):
        if tag == 'style':
            self.in_style = False

    def handle_data(self, data):
        if self.in_style:
            line, col = self.getpos()
            self.styles.append((self.offsets[line - 1] + col, data))


def font_face_span(html):
    """Find one unambiguous Nebulove face in inline CSS; fail before any I/O.

    This is intentionally a narrow CSS scanner, not a general CSS evaluator.
    Quoted values/comments and nested braces/parentheses retain their offsets.
    Multiple Nebulove faces (e.g. unicode-range/weight variants) need an explicit
    selection policy, so do not silently replace the first one.
    """
    matches = []
    for offset, css in StyleParser(html).styles:
        structure = _CSS_TOKEN_RE.sub(lambda m: ' ' * len(m[0]), css)
        uncommented = _CSS_TOKEN_RE.sub(
            lambda m: ' ' * len(m[0]) if m[0].startswith('/*') else m[0], css)
        for match in _FONT_START_RE.finditer(structure):
            start, body = match.start(), match.end()
            depth, end = 1, body
            while end < len(structure) and depth:
                if structure[end] == '{':
                    depth += 1
                elif structure[end] == '}':
                    depth -= 1
                end += 1
            if depth:
                raise ValueError('未闭合的 @font-face 块，拒绝修改。')
            # Split descriptors only at top-level semicolons, not in URL/string values.
            family, part, parens = None, body, 0
            for pos in range(body, end):
                char = structure[pos]
                if char == '(':
                    parens += 1
                elif char == ')':
                    parens -= 1
                if (char == ';' and parens == 0) or pos == end - 1:
                    key, sep, value = uncommented[part:pos].partition(':')
                    if sep and key.strip().lower() == 'font-family':
                        family = value.strip()
                    part = pos + 1
            if family is None or not _FAMILY_RE.fullmatch(family):
                continue
            header = re.search(r'(?:' + _GEN_COMMENT + r'\s*)+$', css[:start])
            if header:
                start = header.start()
            matches.append((offset + start, offset + end))
    if len(matches) != 1:
        raise ValueError('需要且只能有一个 Nebulove @font-face 块，找到 %d 个。' % len(matches))
    return matches[0]


def strip_non_render_text(html):
    """Strip HTML comments/style; conservatively retain JavaScript source.

    Regex comment stripping corrupts strings such as "/* 中文 */". Keeping
    script comments costs a few extra glyphs but cannot remove UI literals.
    """
    # Protect script bodies before stripping HTML comments (which can occur
    # inside JS strings too). The page does not render CSS-generated copy.
    parts = re.split(r'(<script\b[^>]*>.*?</script>)', html, flags=re.S | re.I)
    for i in range(0, len(parts), 2):
        parts[i] = re.sub(r'<!--.*?-->', '', parts[i], flags=re.S)
        parts[i] = re.sub(r'<style\b[^>]*>.*?</style>', '', parts[i], flags=re.S | re.I)
    return ''.join(parts)


def collect_chars(html, all_text=False, extra=""):
    if all_text:
        chars = set(html) | set(unescape(html))
    else:
        # Keep raw text as well: entities in JS strings need not be HTML-decoded.
        text = strip_non_render_text(html)
        chars = set(text) | set(unescape(text))
    chars |= ASCII | PUNCT | set(extra)
    chars.discard("\n")
    chars.discard("\r")
    chars.discard("\t")
    return chars


def build_subset(chars, ttf_path):
    from fontTools.ttLib import TTFont
    from fontTools.subset import Subsetter, Options

    font = TTFont(ttf_path, recalcTimestamp=False)
    try:
        subsetter = Subsetter(options=Options())
        subsetter.populate(text="".join(sorted(chars)))
        subsetter.subset(font)
        font.flavor = "woff2"
        buf = io.BytesIO()
        font.save(buf)
        data = buf.getvalue()
        covered = set((font.getBestCmap() or {}).keys())
        return data, covered
    finally:
        font.close()


def download(url, path):
    with urllib.request.urlopen(url, timeout=60) as r, open(path, "wb") as f:
        f.write(r.read())


def make_font_face(b64, woff_kb, b64_kb, count, mode, full_kb):
    # 只内嵌 data URI：页面承诺零网络请求，不再保留远程兜底地址。
    return (
        "/* ===== Nebulove 子集（内嵌，离线可用）=====\n"
        "   由 scripts/subset_font.py 生成：保留本页收集到的 %d 个字形（%s 模式）。\n"
        "   %.2f MB woff2 → %.1f KB woff2（base64 后 %.1f KB），随页面一起加载、无网络请求。 ===== */\n"
        '@font-face {\n'
        "  font-family: 'Nebulove';\n"
        '  src: url("data:font/woff2;charset=utf-8;base64,%s") format("woff2");\n'
        "  font-weight: normal;\n"
        "  font-style: normal;\n"
        "  font-display: swap;\n"
        "}" % (count, mode, full_kb / 1024, woff_kb, b64_kb, b64)
    )


def atomic_write(path, text):
    # Preserve symlink entry points, as the former open(path, "w") did.
    path = os.path.realpath(path)
    mode = os.stat(path).st_mode & 0o777
    temp_path = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", newline="",
                                         dir=os.path.dirname(os.path.abspath(path)),
                                         prefix=".yitetris-", delete=False) as f:
            temp_path = f.name
            f.write(text)
            f.flush()
            os.fsync(f.fileno())
        os.chmod(temp_path, mode)
        os.replace(temp_path, path)
    finally:
        if temp_path and os.path.exists(temp_path):
            os.unlink(temp_path)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--html", default=DEFAULT_HTML)
    ap.add_argument("--font-url", default=FONT_URL)
    ap.add_argument("--ttf", help="本地字体路径（不下载）；默认下载 Nebulove.woff2")
    ap.add_argument("--extra-chars", help="追加字符集合所在的文本文件")
    ap.add_argument("--all-text", action="store_true", help="保守模式：文件里出现的字符全收")
    ap.add_argument("--check", action="store_true", help="只报告，不写入")
    args = ap.parse_args()

    if not os.path.exists(args.html):
        sys.exit("找不到页面文件：%s" % args.html)
    with open(args.html, encoding="utf-8") as f:
        html = f.read()
    try:
        face_start, face_end = font_face_span(html)
    except ValueError as exc:
        sys.exit(str(exc))

    extra = ""
    if args.extra_chars:
        with open(args.extra_chars, encoding="utf-8") as f:
            extra = f.read()

    chars = collect_chars(html, all_text=args.all_text, extra=extra)
    mode = "全文本" if args.all_text else "可渲染文本"
    print("需要保留的字符：%d 个（%s）" % (len(chars), mode))

    # A private portable temporary directory prevents concurrent downloads from
    # truncating each other (and avoids the old predictable /tmp symlink path).
    with tempfile.TemporaryDirectory(prefix="yitetris-font-") as tmp:
        ttf = args.ttf or os.path.join(tmp, "Nebulove.woff2")
        if not args.ttf:
            print("下载完整字体：%s" % args.font_url)
            download(args.font_url, ttf)
        full_kb = os.path.getsize(ttf) / 1024
        print("完整字体：%.0f KB（%s）" % (full_kb, os.path.basename(ttf)))
        wofl, covered = build_subset(chars, ttf)
    missing = {c for c in chars if ord(c) not in covered}
    print("子集：%.2f KB woff2（%.1f%% 于原字体）" % (len(wofl) / 1024, len(wofl) / (full_kb * 1024) * 100))
    if missing:
        print("⚠️ 字体本身不含这些字符（将回退到系统字体）：%s" %
              " ".join("U+%04X" % ord(c) for c in sorted(missing)))

    if args.check:
        print("--check：不写入任何文件。")
        return
    keep = os.path.join(HERE, "Nebulove-subset.woff2")
    with open(keep, "wb") as f:
        f.write(wofl)
    print("子集文件：%s" % keep)
    b64 = base64.b64encode(wofl).decode("ascii")
    new_face = make_font_face(b64, len(wofl) / 1024, len(b64) / 1024, len(covered), mode, full_kb)
    new_html = html[:face_start] + new_face + html[face_end:]
    if new_html == html:
        print("页面已经是目标内容，未改动。")
        return
    # Replace atomically in the same filesystem; a failed write must not
    # truncate the only source/artifact. Preserve the original file mode.
    atomic_write(args.html, new_html)
    print("已更新 %s（@font-face 替换 1 处）" % args.html)
    print("页面大小：%.0f KB → %.0f KB" % (len(html.encode()) / 1024, len(new_html.encode()) / 1024))


if __name__ == "__main__":
    main()
