"""生成两份**合成** PDF 样张（随包发布 / 验证用）。

为什么需要它们（都是上架审核逼出来的）：

1. `sample-slots.pdf` —— **文字层**作息表。
   审核反馈原文：「应用从教务系统表格导入课表功能需使用网页表格导致未完全遍历，无法测试」。
   测试员手上没有任何课表/作息文件，而「导入作息 → PDF」必须依赖外部文件，于是这条通道
   他永远走不到。有了这份样张，「选文件」换成「点示例」，后面解析 → 校对页 → 写入
   与真实文件**完全同一条代码路径**（只有"文件从哪来"不同）。

2. `image-timetable.pdf` —— **没有文字层**的课表（整页就是一张位图）。
   用来复现审核报的「PDF 文件有内容，提示解析失败，没有可读文本」：
   这类文件（扫描件、或字形码没有 Unicode 映射的生成器产物）在 pdf.js 里一个可读字符
   都取不到，只能渲染成图再交给设备端 OCR。它是 debug 包开发者入口的回归样张。

数据**全部虚构**：没有姓名、学号，课程与时间都是编的（隐私约定见 docs/PRIVACY.md）。
用法：python tools/make-pdf-fixtures.py
"""
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont
from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "entry" / "src" / "main" / "resources" / "rawfile"

FONT = Path("C:/Windows/Fonts/simhei.ttf")

# 12 节，全部虚构；与课表格子里的默认作息不要求一致（导入后会整表替换）
SLOTS = [
    ("上午", "1", "8:00-8:45"),
    ("上午", "2", "8:50-9:35"),
    ("上午", "3", "9:55-10:40"),
    ("上午", "4", "10:45-11:30"),
    ("下午", "5", "14:00-14:45"),
    ("下午", "6", "14:50-15:35"),
    ("下午", "7", "15:55-16:40"),
    ("下午", "8", "16:45-17:30"),
    ("晚上", "9", "19:00-19:45"),
    ("晚上", "10", "19:50-20:35"),
]


def make_slots_pdf() -> Path:
    """文字层作息表：报告厅用的那种「分组 | 节次 | 时间段」表格。"""
    pdfmetrics.registerFont(TTFont("SimHei", str(FONT)))
    title = ParagraphStyle("t", fontName="SimHei", fontSize=18, leading=24, alignment=1)
    body = ParagraphStyle("b", fontName="SimHei", fontSize=11, leading=16)
    cell = ParagraphStyle("c", fontName="SimHei", fontSize=11, leading=15)

    rows = [[Paragraph("分组", cell), Paragraph("节次", cell), Paragraph("时间段", cell)]]
    for group, period, span in SLOTS:
        rows.append([Paragraph(group, cell), Paragraph(period, cell), Paragraph(span, cell)])

    table = Table(rows, colWidths=[30 * mm, 25 * mm, 55 * mm], repeatRows=1)
    table.setStyle(TableStyle([
        ("GRID", (0, 0), (-1, -1), 0.5, colors.HexColor("#9A8C82")),
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#F3E6DC")),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("ALIGN", (1, 1), (1, -1), "CENTER"),
    ]))

    path = OUT / "sample-slots.pdf"
    doc = SimpleDocTemplate(
        str(path), pagesize=A4,
        leftMargin=20 * mm, rightMargin=20 * mm, topMargin=18 * mm, bottomMargin=18 * mm,
        title="作息时间表（示例）", author="jiankebiao sample",
    )
    story = [
        Paragraph("作息时间表（示例）", title),
        Spacer(1, 4 * mm),
        Paragraph("这份文件随应用一起发布，只用于演示「导入作息 → 从 PDF 文件」。"
                  "全部数据为虚构。", body),
        Spacer(1, 6 * mm),
        table,
    ]
    doc.build(story)
    return path


def make_image_timetable_pdf() -> Path:
    """没有文字层的课表 PDF：整页就是一张位图（等价于"扫描件"）。"""
    width, height = 1200, 1600
    img = Image.new("RGB", (width, height), "#FFFFFF")
    draw = ImageDraw.Draw(img)
    big = ImageFont.truetype(str(FONT), 40)
    mid = ImageFont.truetype(str(FONT), 30)
    small = ImageFont.truetype(str(FONT), 26)

    draw.text((40, 32), "我的课表（图片版 · 示例）", font=big, fill="#3B3430")
    draw.text((40, 96), "这一页没有文字层，只能靠图片识别", font=small, fill="#7A6E66")

    days = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"]
    left, top = 40, 160
    col_w = (width - 2 * left) / len(days)
    row_h = 96
    rows = 6
    for i, day in enumerate(days):
        x = left + i * col_w
        draw.rectangle([x, top, x + col_w, top + row_h], fill="#F3E6DC", outline="#9A8C82")
        draw.text((x + 24, top + 30), day, font=mid, fill="#3B3430")
    for r in range(1, rows + 1):
        y = top + r * row_h
        draw.line([left, y, width - left, y], fill="#C9BDB3", width=2)
    for i in range(len(days) + 1):
        x = left + i * col_w
        draw.line([x, top, x, top + rows * row_h], fill="#C9BDB3", width=2)

    # 4 门虚构课程：只占前 5 天，留白让网格识别有边界
    lessons = [(0, 1, "高等数学\nA101"), (1, 2, "线性代数\nB203"),
               (3, 1, "大学物理\nC305"), (4, 3, "程序设计\n机房2")]
    for col, row, text in lessons:
        x = left + col * col_w
        y = top + row * row_h
        draw.rectangle([x + 4, y + 4, x + col_w - 4, y + row_h - 4], fill="#E8F0E9", outline="#7FA98B")
        draw.multiline_text((x + 16, y + 18), text, font=small, fill="#2F4F3E", spacing=8)

    path = OUT / "image-timetable.pdf"
    img.save(path, "PDF", resolution=150.0)
    return path


if __name__ == "__main__":
    for p in (make_slots_pdf(), make_image_timetable_pdf()):
        print(f"{p.name}\t{p.stat().st_size} bytes")
