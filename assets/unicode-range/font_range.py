# pip install "fonttools[woff]"
from fontTools.pens.boundsPen import BoundsPen
from fontTools.ttLib import TTFont


def get_real_unicode_ranges(font_path):
    # WOFF2 폰트 로드
    font = TTFont(font_path)
    cmap = font.getBestCmap()
    glyph_set = font.getGlyphSet()

    # 💡 주의: 띄어쓰기(Space)는 원래 비어있는 게 정상이므로 예외로 살려둡니다.
    # 일반 스페이스(0x0020), Non-breaking 스페이스(0x00A0), 전각 스페이스(0x3000) 등
    SPACE_UNICODES = {0x0020, 0x00A0, 0x3000, 0x0009, 0x000A, 0x000D}

    valid_unicodes = []

    for code, glyph_name in cmap.items():
        # 스페이스바 같은 공백 문자는 통과
        if code in SPACE_UNICODES:
            valid_unicodes.append(code)
            continue

        # 해당 글리프를 그릴 가상의 펜(Pen) 준비
        glyph = glyph_set[glyph_name]
        pen = BoundsPen(glyph_set)

        try:
            # 펜으로 글리프를 그려봄
            glyph.draw(pen)

            # pen.bounds가 None이 아니라는 건 무언가 그려졌다는 뜻 (=빈 폰트가 아님)
            if pen.bounds is not None:
                valid_unicodes.append(code)
        except Exception:
            # 파싱 오류 등 문제가 있는 글리프는 무시
            pass

    # 추출된 유니코드를 정렬
    valid_unicodes.sort()

    # CSS unicode-range 형식(U+XXXX-YYYY)으로 예쁘게 압축하기
    if not valid_unicodes:
        return "No valid glyphs found."

    ranges = []
    start = valid_unicodes[0]
    end = valid_unicodes[0]

    for u in valid_unicodes[1:]:
        if u == end + 1:
            end = u
        else:
            if start == end:
                ranges.append(f"U+{start:04X}")
            else:
                ranges.append(f"U+{start:04X}-{end:04X}")
            start = end = u

    if start == end:
        ranges.append(f"U+{start:04X}")
    else:
        ranges.append(f"U+{start:04X}-{end:04X}")

    return ", ".join(ranges)


if __name__ == "__main__":
    # 사용할 폰트 파일명 입력 (경로에 맞게 수정하세요)
    font_file = "my_font.woff2"

    try:
        css_range = get_real_unicode_ranges(font_file)
        print("=== CSS unicode-range (빈 폰트 제거됨) ===")
        print(css_range)
    except Exception as e:
        print(f"Error: {e}")
