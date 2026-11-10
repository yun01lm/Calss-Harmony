"""把模拟器原生截图裁成应用市场要的 9:16（1080×1920）。

## 为什么需要裁

模拟器 Mate 90 Pro 的屏幕是 1280×2832（9:19.9），而应用市场「应用介绍截图」要求
**宽高比 9:16、最低 1080×1920**（2026-11-10 上传页原文）。9:16 比这块屏"矮"，
所以只能从上下各切掉一截 —— 切哪一截按内容定，别把关键信息切了：

| 截图 | 保留窗口（y 起 .. y 止） | 为什么这么切 |
|---|---|---|
| 1 周课表 | 136 .. 2412 | 去掉状态栏，保留下面的标题/周次 + 第 1~8 节（晚间那几节本来就是空的） |
| 2 课程详情 | 470 .. 2746 | 详情卡贴在屏幕底部，只能切上面；从「本周 / 10 节」那行开始，避开切断「第 1 周」 |
| 3 作息时间 | 136 .. 2412 | 去掉状态栏，保住标题与 10 节作息（底部那排按钮不是重点） |
| 4 导入课表 | 470 .. 2746 | 三通道按钮在底部弹层里，同上；到底前留一点白，不把系统手势条切进来 |

切出来的窗口是 1280×2276（正好 9:16），再缩到 1080×1920。

## 用法

    python tools/make-store-shots.py

原生图放 `store/screenshots/native/`，成品写回 `store/screenshots/`。
"""

from PIL import Image
import os
import sys

SRC_DIR = os.path.join("store", "screenshots", "native")
OUT_DIR = os.path.join("store", "screenshots")

TARGET_W, TARGET_H = 1080, 1920          # 9:16，应用市场最低尺寸
WINDOWS = {
    "1-周课表.jpeg": (136, 2412),
    "2-课程详情.jpeg": (470, 2746),
    "3-作息时间.jpeg": (136, 2412),
    "4-导入课表.jpeg": (470, 2746),
}


def main() -> int:
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    src_dir = os.path.join(root, SRC_DIR)
    out_dir = os.path.join(root, OUT_DIR)
    if not os.path.isdir(src_dir):
        print("找不到原生截图目录：" + src_dir)
        return 1

    for name, (top, bottom) in WINDOWS.items():
        path = os.path.join(src_dir, name)
        if not os.path.exists(path):
            print("缺文件：" + path)
            return 1
        im = Image.open(path).convert("RGB")
        win_h = bottom - top
        # 窗口必须是 9:16，否则缩放会被拉伸 —— 这里直接断言，不做"差不多"
        expect = im.width * 16 / 9
        if abs(win_h - expect) > 1.5:
            print(f"{name}: 窗口高 {win_h} 不是 {im.width}×16/9={expect:.0f}，会变形")
            return 1
        cropped = im.crop((0, top, im.width, bottom))
        out = cropped.resize((TARGET_W, TARGET_H), Image.LANCZOS)
        out_path = os.path.join(out_dir, name)
        out.save(out_path, quality=92, optimize=True)
        ratio = out.width / out.height
        print(f"{name}: {im.size} → 窗口 y{top}..{bottom} → {out.size} "
              f"(9:{out.height / out.width * 9:.2f}) {os.path.getsize(out_path) // 1024} KB")
        assert abs(ratio - 9 / 16) < 1e-6
    return 0


if __name__ == "__main__":
    sys.exit(main())
