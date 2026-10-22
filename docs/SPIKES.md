# Spike 结论（阶段 2 末尾，做导入之前）

平台能力到底给不给我们要的数据 —— 这两件事决定阶段 3 的导入怎么写，所以先验再写。

设备：模拟器 Mate 90 Pro（HarmonyOS 7.0.0 / API 26，x86 镜像）。
代码：`platform/SpikeProbe.ts`（开发者入口 → 「跑 spike」按钮）。存证：`docs/evidence/21-spike-panel.jpeg`、`22-spike-result.jpeg`。

---

## Spike B：PDF Kit 能不能给"带坐标的文本片段"

**结论：不能。两条路都堵死了。**

| 路线 | 结果 |
|---|---|
| `PdfPage.getTextContent()` | 文档明确写着"返回包含转义字符的**字符串**"（API 23 起），**没有坐标**。而 `logic/GridFormatParser.ts` / `ListFormatParser.ts` 靠 `(x, y)` 判断"这串字属于星期几那一列" —— 纯字符串用不上 |
| `PdfPage.getGraphicsObjects()` | 它返回的是**编辑 API 加进去的**图形对象（`addTextObject` 等），不是页面原有的文字。而 `PdfPage` 的公开方法里没有任何"取页面文本块"的接口 |
| 设备实测 | `typeof pdfService = undefined` —— 这个模拟器镜像里**根本没有 PDF Kit 模块**，调用直接 `TypeError` |

也就是说：即便换到真机，`getTextContent()` 也只能给出**读得懂但没法定位**的文本。
对"网格版式课表"（我们的主场景）等于不可用。

> 顺带一个反例，说明为什么不能将就：`ListFormatParser` 也要按 `page + y` 分组合并同一门课的续行，
> 没有 y 就只能全靠猜 —— 那正是我们一直拒绝的"看起来能跑"。

## Spike C：Core Vision Kit 的中文 OCR

**结论：模块在，服务在这台模拟器上跑不起来。**

| 调用 | 结果 |
|---|---|
| `typeof textRecognition` | `object`（模块存在） |
| `textRecognition.init()` | `[200] Run timed out, please try again later.` |
| `getSupportedLanguages()` | `[1001400001] Failed to run OCR, please try again` |
| `recognizeText()`（重试 3 次） | `[1001400001] Failed to run OCR, please try again` |

`1001400001` 是"OCR 服务异常"，不是参数错、也不是权限拒。图片确实载入成功（900×760 RGBA_8888），
所以不是我们喂错了数据 —— 是这台 x86 模拟器没有可用的 OCR 后端（AI 能力通常依赖真机上的模型/加速）。

---

## 对阶段 3 的影响

| 功能 | 原计划 | 现状 |
|---|---|---|
| 作息编辑、多课表 | 直接做 | ✅ 不受影响，可正常实现并验证 |
| PDF 导入 | PDF Kit 取文本 | ❌ 无坐标；且模拟器没有该模块 |
| 截图 OCR 导入 | Core Vision | ⚠️ 代码可以按 API 写，但**这台设备上无法验证** |

可选的两条路（需要决定）：

1. **PDF 改走 ArkWeb + pdf.js**：pdf.js 在 WebView 里解析，`textContent.items` 带 `transform` 矩阵，
   坐标齐全，能直接喂给现有的 `GridFormatParser`。**这条能在模拟器上验证**，
   代价是要打包 pdf.js（约 1MB，与"小而快"的目标有冲突，且多一层 WebView）。
2. **先不做导入**：这一版只做作息编辑 / 多课表 / 手动增删课，
   PDF 与 OCR 等到有真机（或确定 pdf.js 方案）再做。

> 需要用户决定的是：有没有**真机**可以测？有 → OCR 这条路可验证；
> 没有 → OCR 只能"按 API 写好但未验证"，而 PDF 要么走 pdf.js 要么不做。

---

## 附带记录

- 这一轮模拟器自己崩过一次（hdc 掉线、无 Emulator 进程），已用 `Emulator.exe -license accept` + `-start "Mate 90 Pro" -noWindow` 重启；应用与数据库都还在（重启后 4 门示例课仍在，等于又验了一次持久化）。
- spike 夹具是**合成**的（`tools/spike/timetable.html` + `make_schedule_png.py`），不含任何真实课表或个人姓名：
  - `entry/src/main/resources/rawfile/spike-timetable.pdf`（Chrome 打印生成，含中文字体）
  - `entry/src/main/resources/rawfile/spike-schedule.png`（Pillow + 微软雅黑渲染的作息表）
