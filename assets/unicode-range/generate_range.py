#!/usr/bin/env python3
"""
Download emoji-style.txt from unicode.org and generate CSS unicode-range for @font-face.

Usage:
    python generate_range.py
    python generate_range.py --out emoji-range.css
"""

import sys
import urllib.request
from pathlib import Path

EMOJI_STYLE_URL = "https://unicode.org/emoji/charts/emoji-style.txt"


def download_emoji_style() -> str:
    """Download emoji-style.txt from unicode.org."""
    print(f"Downloading {EMOJI_STYLE_URL} ...", file=sys.stderr)
    with urllib.request.urlopen(EMOJI_STYLE_URL) as resp:
        raw = resp.read()
    # Handle BOM
    text = raw.decode("utf-8-sig")
    print(f"  Downloaded {len(raw)} bytes", file=sys.stderr)
    return text


def extract_codepoints(text: str) -> set[int]:
    """Extract all unique Unicode codepoints from emoji characters in the file."""
    codepoints: set[int] = set()

    for line in text.splitlines():
        line = line.strip()
        # Skip empty lines, headers, and section labels
        if not line or line.startswith(
            ("Should ", "•", "For ", "Emoji Default", "This text")
        ):
            continue
        # Skip section headers
        if line in (
            "text+ts",
            "text-vs",
            "text+es",
            "emoji cps",
            "emoji reg/tags",
            "modifier",
            "zwj emoji",
        ):
            continue

        # Each remaining line has space-separated emoji characters
        for char_seq in line.split():
            for cp in char_seq:
                code = ord(cp)
                # Skip ASCII and basic Latin
                if code < 0x80:
                    continue
                codepoints.add(code)

    return codepoints


def merge_ranges(codepoints: set[int]) -> list[tuple[int, int]]:
    """Merge sorted codepoints into contiguous ranges."""
    if not codepoints:
        return []

    sorted_cps = sorted(codepoints)
    ranges: list[tuple[int, int]] = []
    start = prev = sorted_cps[0]

    for cp in sorted_cps[1:]:
        if cp == prev + 1:
            prev = cp
        else:
            ranges.append((start, prev))
            start = prev = cp

    ranges.append((start, prev))
    return ranges


def format_unicode_range(ranges: list[tuple[int, int]]) -> str:
    """Format ranges as CSS unicode-range value."""
    parts: list[str] = []
    for start, end in ranges:
        if start == end:
            parts.append(f"U+{start:04X}")
        else:
            parts.append(f"U+{start:04X}-{end:04X}")
    return ", ".join(parts)


def generate_css(unicode_range: str) -> str:
    """Generate @font-face CSS with the unicode-range."""
    return f"""\
/* Auto-generated from {EMOJI_STYLE_URL} */
/* Ensures emoji codepoints use system emoji font instead of text font */

@font-face {{
  font-family: "Emoji";
  src: local("Apple Color Emoji"),
       local("Segoe UI Emoji"),
       local("Noto Color Emoji");
  unicode-range: {unicode_range};
}}
"""


def main():
    script_dir = Path(__file__).parent

    text = download_emoji_style()

    codepoints = extract_codepoints(text)
    ranges = merge_ranges(codepoints)
    unicode_range = format_unicode_range(ranges)

    css = generate_css(unicode_range)

    # Output
    if "--out" in sys.argv:
        idx = sys.argv.index("--out")
        out_path = script_dir / sys.argv[idx + 1]
        out_path.write_text(css, encoding="utf-8")
        print(f"Written to {out_path}", file=sys.stderr)
        print(f"  {len(codepoints)} codepoints → {len(ranges)} ranges", file=sys.stderr)
    else:
        print(css)
        print(
            f"/* {len(codepoints)} codepoints → {len(ranges)} ranges */",
            file=sys.stderr,
        )


if __name__ == "__main__":
    main()
