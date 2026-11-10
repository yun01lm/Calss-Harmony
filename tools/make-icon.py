"""生成「简课表」图标：与应用市场一致、且与 Android 版**同一份几何**。

## 为什么重写
Android 版用的是自适应图标（adaptive icon）：
- 背景层：纯色 `#E07A5F`
- 前景层：白色圆角「课表板」+ 陶土色格线（108×108 视口里画好，启动器只显示中间 72×72）

应用市场要的是**直角正方形**（216 或 1024，PNG/WEBP ≤3MB），由它自己套圆角蒙层；
同时明确要求"上传的图标必须与软件包里的图标一致"。所以两边必须来自同一份画法：

- `store/icon-1024.png`         —— 上传用直角图（背景 + 前景合成，按可见窗口裁剪）
- `AppScope/.../background.png` —— 鸿蒙分层图标的背景层（1024，纯色）
- `AppScope/.../foreground.png` —— 前景层（1024，透明底）
- `entry/.../startIcon.png`     —— 启动图（144，前景层）

## 谁是"真源"（实测，不是推测）
打包时 **应用图标只认 `AppScope`**：把 AppScope 的前景临时换成一块绿方块重新构建，
包里的 `resources/base/media/foreground.png` 立刻变成绿方块；而改 `entry` 下的同名图
完全不影响包内图标。`entry` 那两份曾经存在的 `background/foreground.png` 其实是死文件，
已删除，避免"改了一份没效果"。

另外，包内的分层图标会被 hvigor 统一归一到 **512×512**（无论给 288 还是 1024），
所以尺寸统一在 AppScope 出 1024、由构建去缩，不必自己先缩一遍。

## 几何（108 用户单位，源自 Android 的 vector）
```
白色板:   x 36..72, y 38..70, 圆角 4
横格线:   y 50..53 / 59..62, x 36..72
竖格线:   x 48..51 / 57..60, y 38..70
```
自适应图标的可见区域是中间 **72×72**（18..90），所以这里把 18..90 映射到整张 1024 ——
这样应用市场里的直角图、以及手机上被套了蒙层的显示，看起来和 Android 一致。
"""

from PIL import Image, ImageDraw
import os

STORE_SIZE = 1024
START_ICON = 144

BG_COLOR = (224, 122, 95, 255)   # #E07A5F 暖陶土
BOARD_COLOR = (255, 255, 255, 255)

# 自适应图标的可见窗口（108 视口里的 18..90）
VIEW_MIN = 18.0
VIEW_SPAN = 72.0


def _px(u: float, size: int) -> int:
    """用户单位（108 视口）的**坐标** → 像素坐标（0..size）。

    必须取整：Pillow 的 rounded_rectangle 在大圆角 + 浮点时会在算拐角包围盒时报
    "x1 must be greater than or equal to x0"。取整后误差 < 1px，看不出来。
    """
    return int(round((u - VIEW_MIN) * (size / VIEW_SPAN)))


def _len(u: float, size: int) -> int:
    """用户单位的**长度**（圆角半径、线宽）→ 像素。

    不能复用 _px：那会把坐标原点（18）也减掉，_px(4, 1024) 得到负数，
    传进 radius= 直接炸（实测踩过）。
    """
    return max(1, int(round(u * (size / VIEW_SPAN))))


def foreground(size: int) -> Image.Image:
    """前景层：白色课表板 + 陶土色格线（透明底）"""
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    def box(x0: float, y0: float, x1: float, y1: float):
        return [_px(x0, size), _px(y0, size), _px(x1, size), _px(y1, size)]

    # 白色圆角板
    d.rounded_rectangle(box(36, 38, 72, 70), radius=_len(4, size), fill=BOARD_COLOR)
    # 格线（用背景色"刻"出来，与 Android 的 vector 一致）
    d.rectangle(box(36, 50, 72, 53), fill=BG_COLOR)   # 横 1
    d.rectangle(box(36, 59, 72, 62), fill=BG_COLOR)   # 横 2
    d.rectangle(box(48, 38, 51, 70), fill=BG_COLOR)   # 竖 1
    d.rectangle(box(57, 38, 60, 70), fill=BG_COLOR)   # 竖 2
    return img


def background(size: int) -> Image.Image:
    """背景层：纯色（应用市场与启动器都会裁切/套蒙层，所以给满幅）"""
    return Image.new("RGBA", (size, size), BG_COLOR)


def main() -> None:
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    app_media = os.path.join(root, "AppScope", "resources", "base", "media")
    entry_media = os.path.join(root, "entry", "src", "main", "resources", "base", "media")
    store_dir = os.path.join(root, "store")
    os.makedirs(store_dir, exist_ok=True)

    bg = background(STORE_SIZE)
    fg = foreground(STORE_SIZE)

    # 1) 应用市场：背景 + 前景合成的直角图
    store_icon = Image.alpha_composite(bg, fg).convert("RGB")
    store_path = os.path.join(store_dir, "icon-1024.png")
    store_icon.save(store_path, optimize=True)

    # 2) 鸿蒙分层图标：只有 AppScope 这一份是真源（见文件头「谁是"真源"」）
    bg.save(os.path.join(app_media, "background.png"))
    fg.save(os.path.join(app_media, "foreground.png"))
    # 启动图仍然由 entry 模块提供（包里 startIcon.png 与这里逐字节相同）
    fg.resize((START_ICON, START_ICON), Image.LANCZOS).save(os.path.join(entry_media, "startIcon.png"))

    # 3) 本地预览（不入库）：整图 + 缩到 56px 看小尺寸是否还认得出
    store_icon.save(os.path.join(root, "tmp-icon-preview.png"))
    store_icon.resize((56, 56), Image.LANCZOS).resize((224, 224), Image.NEAREST).save(
        os.path.join(root, "tmp-icon-56.png")
    )
    print("store:", store_path, os.path.getsize(store_path), "bytes")


if __name__ == "__main__":
    main()
