"""生成 OCR 用的合成"作息表"图片（含中文，白底黑字，接近手机截图效果）。

只在 spike 阶段用一次，产物进 entry/src/main/resources/rawfile/spike-schedule.png。
用法：python tools/spike/make_schedule_png.py
"""
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "entry" / "src" / "main" / "resources" / "rawfile" / "spike-schedule.png"

FONT_CANDIDATES = [
    r"C:\Windows\Fonts\msyh.ttc",
    r"C:\Windows\Fonts\simsun.ttc",
]

LINES = [
    ("作息时间表（合成夹具）", 44, 40),
    ("上午 1   8: 00-8: 45", 36, 130),
    ("课间     8: 45-8: 50", 28, 195),
    ("上午 2   8: 50-9: 35", 36, 250),
    ("课间     9: 35-9: 55", 28, 315),
    ("上午 3   9: 55-10: 40", 36, 370),
    ("上午 4   10: 45-11: 30", 36, 430),
    ("下午 5   14: 00-14: 45", 36, 495),
    ("下午 6   14: 50-15: 35", 36, 555),
    ("晚上 9   19: 00-19: 45", 36, 620),
    ("晚上 10  19: 50-20: 35", 36, 680),
]


def pick_font(size: int) -> ImageFont.FreeTypeFont:
    for path in FONT_CANDIDATES:
        if Path(path).exists():
            return ImageFont.truetype(path, size)
    raise SystemExit("找不到中文字体")


def main() -> None:
    width, height = 900, 760
    image = Image.new("RGB", (width, height), (255, 255, 255))
    draw = ImageDraw.Draw(image)
    for text, size, y in LINES:
        draw.text((60, y), text, font=pick_font(size), fill=(20, 20, 20))
    OUT.parent.mkdir(parents=True, exist_ok=True)
    image.save(OUT, "PNG")
    print(f"wrote {OUT} ({OUT.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
