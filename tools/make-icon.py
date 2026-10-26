"""生成「简课表」的应用图标（分层图标 background / foreground + 启动图 startIcon）。

设计：直接把界面里的**课表网格**搬到图标上 —— 4 列 × 3 行的白色圆角块，
其中三块跨行/单格用应用主色（课程块的橙、蓝、绿）。理由：

- 一屏 20 个图标里，颜色少、形状大才认得出。这里只有"白格 + 3 个彩块"两层次；
- 它和应用内周视图是同一个视觉语言（彩色色块落在网格里），不会"图标和界面不像一家人"；
- 不用文字：中文字在 48px 下必然糊。

底色用暖色渐变（#FFE4D0 → #FFCEB8），白格子的对比度在小尺寸下才够。
输出：AppScope 1024×1024；entry 288×288；startIcon 144×144（透明底）。
"""

from PIL import Image, ImageDraw
import os

SIZE = 1024
BG_TOP = (255, 228, 208)
BG_BOTTOM = (255, 206, 184)
TILE = (255, 255, 255, 235)
ACCENT_A = (222, 107, 78, 255)    # #DE6B4E（课程块橙）
ACCENT_B = (95, 132, 184, 255)    # #5F84B8（蓝）
ACCENT_C = (111, 160, 127, 255)   # #6FA07F（绿）

CELL = 150
GAP = 18
RADIUS = 38


def background(size: int) -> Image.Image:
    img = Image.new("RGBA", (size, size), BG_TOP + (255,))
    d = ImageDraw.Draw(img)
    for y in range(size):
        t = y / (size - 1)
        d.line(
            [(0, y), (size, y)],
            fill=(
                round(BG_TOP[0] + (BG_BOTTOM[0] - BG_TOP[0]) * t),
                round(BG_TOP[1] + (BG_BOTTOM[1] - BG_TOP[1]) * t),
                round(BG_TOP[2] + (BG_BOTTOM[2] - BG_TOP[2]) * t),
                255,
            ),
        )
    return img


def foreground(size: int) -> Image.Image:
    """4 列 × 3 行；其中 1 块跨两行（橙）、1 块跨两行（蓝）、1 块单格（绿）。"""
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    scale = size / 1024.0
    cell = CELL * scale
    gap = GAP * scale
    rows, cols = 3, 4
    grid_w = cols * cell + (cols - 1) * gap
    grid_h = rows * cell + (rows - 1) * gap
    x0 = (size - grid_w) / 2
    y0 = (size - grid_h) / 2
    radius = RADIUS * scale

    def box(c: int, r: int, span: int = 1):
        x = x0 + c * (cell + gap)
        y = y0 + r * (cell + gap)
        return [x, y, x + cell, y + cell + (span - 1) * (cell + gap)]

    accent = {(1, 0): ACCENT_A, (2, 1): ACCENT_B, (3, 2): ACCENT_C}
    for r in range(rows):
        for c in range(cols):
            # 被跨行块覆盖的格子不画（(c, r) 自身是起点，或上一行是起点）
            if (c, r) in accent or (c, r - 1) in accent:
                continue
            d.rounded_rectangle(box(c, r), radius=radius, fill=TILE)

    d.rounded_rectangle(box(1, 0, 2), radius=radius, fill=ACCENT_A)
    d.rounded_rectangle(box(2, 1, 2), radius=radius, fill=ACCENT_B)
    d.rounded_rectangle(box(3, 2), radius=radius, fill=ACCENT_C)
    return img


def main() -> None:
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    app_media = os.path.join(root, "AppScope", "resources", "base", "media")
    entry_media = os.path.join(root, "entry", "src", "main", "resources", "base", "media")

    bg = background(SIZE)
    fg = foreground(SIZE)

    bg.save(os.path.join(app_media, "background.png"))
    fg.save(os.path.join(app_media, "foreground.png"))

    bg.resize((288, 288), Image.LANCZOS).save(os.path.join(entry_media, "background.png"))
    fg.resize((288, 288), Image.LANCZOS).save(os.path.join(entry_media, "foreground.png"))
    fg.resize((144, 144), Image.LANCZOS).save(os.path.join(entry_media, "startIcon.png"))

    # 本地预览（不参与构建）：整图 + 56px 缩小图，用来看小尺寸下还认不认得出
    preview = Image.alpha_composite(bg, fg).convert("RGB")
    preview.save(os.path.join(root, "tmp-icon-preview.png"))
    preview.resize((56, 56), Image.LANCZOS).resize((224, 224), Image.NEAREST).save(
        os.path.join(root, "tmp-icon-56.png")
    )
    print("icons written:", bg.size, fg.size)


if __name__ == "__main__":
    main()
