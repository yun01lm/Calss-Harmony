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

## Spike B′：改走 ArkWeb + pdf.js（已验证通过）

PDF Kit 不可用之后选了这条路。结论：**运输层通了，坐标可用**。

实现：
- `rawfile/pdfjs/`：pdf.js 3.11.174 legacy 构建（`pdf.min.js` 377KB + `pdf.worker.min.js` 1.13MB）
- `rawfile/pdfjs/viewer.html`：唯一懂 pdf.js 的地方（WebView 里跑 JS）
- `logic/PdfRunText.ts`：解析回传的制表符文本（纯逻辑，**8 条断言**）
- `platform/PdfJs.ts`：桥接（注册 JS 代理 / rawfile → base64）

实机（`docs/evidence/23-pdfjs-panel.jpeg`、`24-pdfjs-result.jpeg`）：

| 项 | 结果 |
|---|---|
| ArkWeb 载入本地 pdf.js 页面 | ✅ `onPageEnd` 触发，按钮可用 |
| `registerJavaScriptProxy` 回传 | ✅ `report(payload)` 收到 |
| 合成 PDF 解析 | ✅ **1 页 / 28 个带坐标的文本片段**，样本 `1(121,60)"2026 春季学期课表…"`、`1(119,82)"星期一"` |
| 坐标方向 | y 向下递增（与 `PdfTextRun` 约定一致） |
| 我们的两个解析器 | ❌ 0 门 —— **符合预期**：合成夹具是 HTML 表格版式，而 `GridFormatParser` 认的是"课程名 + `(3-4节)1-16周/地点/教师`"这种真实版式 |

也就是说：**平台这一侧不再有未知数**，剩下的是"解析器配不配得上真实文件"，
而这部分本来就在 Node 上有 24 条断言（`tests/pdf-parsers.test.ts`）。

代价：HAP 从 ~0.4MB 涨到 **2.17MB**（pdf.js 占大头）。

下一步要做的是导入界面 + 一个**版式逼真**的合成 PDF 夹具（现在这个只够验运输层）。

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

## Spike B″：真实课表 PDF（用户提供的文件）

**结论：能解析，但必须先解决"中文 CMap"这件事。**

真实文件特征：`/Type0 /Encoding UniGB-UCS2-H`，字体 STSong-Light（Adobe-GB1）。
- 页面里**有 204 个 `Tj`/`TJ` 文本算子**（解压内容流数出来的），不是纯图形；
- 但 pdf.js 一开始报 **"2 页 / 0 个文本项"** —— 一个字都取不出来；
- 原因链（WebView 控制台原文，靠 `Web(...).onConsole` 才看到）：
  1. 字体是 CID 键控、**没有 `/ToUnicode`** → pdf.js 必须加载预定义 CMap；
  2. `cMapUrl: 'cmaps/'` 指向 `resource://rawfile/…` →
     `Access to XMLHttpRequest … blocked by CORS policy: Cross origin requests are only
     supported for protocol schemes: arkweb, arkweb-extension, chrome, …`；
  3. CMap 加载失败 → pdf.js 把整页文字**丢掉**（只打 warning，不向业务层报错）。

**解法**：把 GB 系列 CMap 以 base64 内联进 `cmaps-data.js`（182KB），用自定义
`CMapReaderFactory` 直接从内存喂字节，**不发任何请求**。

修复后的实机结果：

```
pdf.js 回传 · 2 页 / 217 个文本片段
GridFormatParser（网格版式）· 24 门
首门课 · 概率论与数理统计 · 周1 第 5-6 节 · 周次 1-12 · 思源楼-411
```

即 **真实课表 PDF → pdf.js → GridFormatParser → 24 门课**，整条链在模拟器上跑通。

> 隐私：这份真实课表含姓名，只用于本地验证。已加入 `.gitignore`
> （`entry/src/main/resources/rawfile/spike-real*.pdf`），验完立即删除；
> 也**没有提交任何截图**（截图里有姓名）。仓库里只有合成的 `spike-grid.pdf`。

## Spike C′：真实作息截图（用户提供的图片）

模拟器没有 OCR，但**本机 Windows 自带 OCR** 支持中文（`zh-Hans-CN`），
于是用 `tools/spike/ocr_image.ps1` 对真实截图做 OCR，再用
`tools/spike/analyze_ocr.mjs` 把结果交给仓库里真实的 `TimetableTextParser`。

**这一步抓到一个真 bug**：真实 OCR 把连字符读成了冒号/间隔号 ——
`8: 00-8: 45` → `8 ： 00 ： 45`、`8: 50-9: 35` → `8 ： 50 · 9 ： 35`，
而 `TIME_RANGE` 的分隔符只认 `[-~—–－〜]`，于是 **12 节一节都认不出（0/12）**。

把 `:：·・` 也算成区间分隔符之后：**8/12**，剩下 4 节恰好是 OCR 本身缺字的行
（第 1 节被读成 `8 ： 00 ： 45`，少了一个 8；10/11 节的节次号整个丢了）。
解析器如实报出"第 1、10 节没认出来，可点「补一节」"，**不瞎补**。

这份真实 OCR 结果已固化成夹具：`tests/fixtures/timetable-ocr-windows.tsv` +
`tests/real-ocr-fixture.test.ts`（3 条断言）。

---

## 附带记录

- 这一轮模拟器自己崩过一次（hdc 掉线、无 Emulator 进程），已用 `Emulator.exe -license accept` + `-start "Mate 90 Pro" -noWindow` 重启；应用与数据库都还在（重启后 4 门示例课仍在，等于又验了一次持久化）。
- spike 夹具是**合成**的（`tools/spike/timetable.html` + `make_schedule_png.py`），不含任何真实课表或个人姓名：
  - `entry/src/main/resources/rawfile/spike-timetable.pdf`（Chrome 打印生成，含中文字体）
  - `entry/src/main/resources/rawfile/spike-schedule.png`（Pillow + 微软雅黑渲染的作息表）
