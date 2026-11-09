"""Check that the code blocks in an HTML page equal the fenced code blocks of its Markdown source.

Usage: python check_code_blocks.py <page.html> <source.md> [language]

Compares, in order, every <pre><code>…</code></pre> in the page with every ```<language> block in the
Markdown file (default: any language). Line endings are normalised; everything else must match.
"""

import html
import re
import sys
from pathlib import Path


def main() -> int:
    if len(sys.argv) < 3:
        print(__doc__)
        return 2
    page = Path(sys.argv[1]).read_text(encoding="utf-8")
    source = Path(sys.argv[2]).read_text(encoding="utf-8").replace("\r\n", "\n")
    language = sys.argv[3] if len(sys.argv) > 3 else r"[\w-]*"
    expected = [b.strip() for b in re.findall(rf"```{language}\n(.*?)```", source, flags=re.S)]
    found = [
        html.unescape(re.sub(r"<[^>]+>", "", m.group(1))).replace("\r\n", "\n").strip()
        for m in re.finditer(r"<pre[^>]*>(.*?)</pre>", page, flags=re.S)
    ]
    ok = found == expected
    print(f"code blocks: page {len(found)}, source {len(expected)}, identical: {ok}")
    for i, (a, b) in enumerate(zip(found, expected), 1):
        if a != b:
            print(f"  block {i} differs: page starts {a[:60]!r}, source starts {b[:60]!r}")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
