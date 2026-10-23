# 验收记录（阶段 4）

环境：Windows 11 + DevEco Studio 26.0.0 / SDK API 26 / hvigor 6.26.8；
设备：**Mate 90 Pro 模拟器**（x86 镜像，软件渲染，无 GPU 加速）；
对比基准：Android 版（Calss-Android）在同一台机器的模拟器上测得 178 ms / 9.68 MB / 零权限。

> 所有数字都是**实测**，不是估算。测法写在每一项下面，方便复现。

## 1. 冷启动

测法：`aa force-stop` → `hilog -r` → `aa start` → 取**进程第一条日志**（`APPSPAWN: AppSpawnChild`）
到 `WMSMain: NotifyCompleteFirstFrameDrawing` 的时间差，取 3 次。

| 构建 | 各次（ms） | 中位数 |
|---|---|---|
| debug · 首帧就挂隐藏 WebView（加载 pdf.js） | 1042 / 1446 / 1223 | **1223** |
| debug · WebView 常驻但停在 about:blank | 1102 / 1244 / 1095 | **1102** |
| debug · WebView **用时才创建**（最终方案） | 698 / 737 / 660 | **698** |
| release（AOT）· 懒创建 | 598 / 692 / 644 | **644** |

结论：
1. **只要 Web 组件在组件树里，进程启动就要为 ArkWeb 付约 0.4~0.5s**
   （日志里 `C04500/webview: CalculateActiveWebEngineVersion` 早于 `LoadModule`）；
   再让它真的加载 1.5MB 的 pdf.js，就再多 0.2~0.6s。
2. 所以最终方案是 **点「导入」时才创建 Web 组件**（`if (this.webRequested)`），
   并且 `src` 直接写 `resource://rawfile/pdfjs/viewer.html`（用 `$rawfile()` 或后置 `loadUrl`
   在这台设备上都会出问题，见下节）。
3. release 与 debug 差别不大 → **瓶颈不在 ArkTS 代码**，而在 ArkUI 引擎与模拟器的软件渲染。
   首帧不做任何数据库操作（`EntryAbility.onCreate` 为空，`aboutToAppear` 只是发起异步加载）。
4. 与 Android 版（178 ms）比，这台模拟器上约慢 3.5 倍。**真机预期明显更快**，
   但这一条目前**没有真机数据**，不作承诺。

## 2. 体积

| 项 | 大小 |
|---|---|
| HAP（release，未签名） | **2.17 MB**（2,271,743 字节） |
| ├─ pdf.js 3.11 legacy（`pdf.min.js` + worker） | 1.51 MB |
| ├─ 内联中文 CMap（`cmaps-data.js`） | 182 KB |
| └─ 应用自身（ArkTS 字节码 + 资源） | 约 0.5 MB |
| Android APK（对比） | 9.68 MB |

pdf.js 占了 68% —— 这是「PDF 导入」这个功能换来的，**不是框架开销**。
如果以后能把导入拆成按需下发的特性包（HSP），主体可以回到 0.7MB 以内。

## 3. 权限

| 检查点 | 结果 |
|---|---|
| `entry/src/main/module.json5` 的 `requestPermissions` | **不存在该字段**（全文没有权限声明） |
| 设备侧 `bm dump -n com.calss.schedule.harmony` | `reqPermissions: []`、`reqPermissionStates: []`、`permissions: []` |
| 文件选择 | 走系统 `DocumentViewPicker`，**不需要**任何读存储权限 |

即：与 Android 版一样是**零权限**应用。

## 4. 测试与构建

| 项 | 结果 |
|---|---|
| Node 断言 | **253 条 / 17 套**（`node --test "tests/*.test.ts"`，不需要鸿蒙 SDK） |
| 架构守卫 | `logic/`、`data/` 零平台依赖、相对 import 带 `.ts`、不跨层（`node tools/check-architecture.mjs`，见第 8 节） |
| ArkTS 构建 | `BUILD SUCCESSFUL`（debug 与 release 都验过，release 装到模拟器跑过） |
| CI | GitHub Actions：每次 push / PR 跑全部断言 + 架构守卫脚本 |

## 5. 功能覆盖（相对 Android 版）

| 功能 | 状态 |
|---|---|
| 周视图（7 列 × N 节、今天高亮、并排冲突、翻周、回到本周、详情卡） | ✅ |
| 「打开即当前周」两条抑制规则 | ✅ 11 个用例（其中 6 个是时序复演，共 28 处断言） |
| 多课表（列表/切换/新建/重命名/主课表/删除/启动开关） | ✅ |
| 作息编辑（改时间/加一节/删一节自动重编号/恢复默认） | ✅ |
| PDF 导入（选文件 → 预览 → 覆盖/合并/新建课表） | ✅ 真实课表认得 24 门；按「名称+教师+地点」归并成一门课多时段 |
| 新建/编辑课程（点空白格新建、点色块编辑·删除） | ✅ 实机建·改·删都验过（`evidence/32~35`） |
| 学期设置（开学日 / 总周数，周视图顶部进） | ✅ 实机改过 20 → 18 周（`evidence/34`） |
| 自定义安排（数据层 + 读写） | 🔶 数据层可用，**界面未做** |
| 截图 OCR 导入 | ⬜ 模拟器无 OCR 后端，需真机 |

## 6. 踩过的平台坑（都花了实机调试时间，记下来）

1. **`runJavaScript` 的返回值是 JSON 字面量**：JS 里返回空串，ArkTS 侧收到的是 `""`（两个引号）；
   返回 `"1"` 时收到的是 `"\"1\""`。一开始拿它直接判空/比较，导致
   "页面永远没就绪" 和 "结果里有转义换行" 两种怪现象。现在统一用 `JSON.parse` 还原。
2. **`Web({ src: $rawfile(...) })` 在"事后创建"的组件里不会触发 `OnPageEnd`**；
   而 `loadUrl()` 在组件还没挂载时又报 `The WebviewController must be associated with a Web component`。
   可用的组合是：条件创建 + `src` 直接写 `resource://rawfile/...`。
3. **`Scroll` 在内容比视口矮时会把内容垂直居中**（列表跑到屏幕中间）。
   列表类界面改用 `List` + `ListItem`。
4. **子组件的数据参数必须 `@Prop`**：普通成员只在创建时赋值一次，父组件更新不会下发
   （周视图第一版就是网格一直空着，而标题栏已经更新）。
5. **`resource://rawfile` 上不能发 XHR/fetch**（CORS 只允许 arkweb/http/https/data），
   所以 pdf.js 的中文 CMap 只能内联成 JS 变量，不能走 `cMapUrl` 目录。

## 7. 遗留风险

1. **冷启动只在模拟器上量过**，真机未测（模拟器是软件渲染，数字偏悲观）。
2. **PDF 导入的解析正确率**只在 1 份真实课表上验过（24 门）。不同学校的版式差异大，
   解析器是"尽力而为 + 预览确认"的设计，不会静默写错。
3. **OCR 通道完全没有端到端验证**（模拟器无后端）。代码可以写，但不写就少一块功能 —— 待真机。
4. 冲突格的并排显示在窄列下文字会竖排（与 Android 版一致的既有行为）。
5. **pdf.js 的 Web 组件用过之后常驻**（约 1.5 MB + 一个 worker），下次启动会慢 ~0.4s。
   计划：导入结束后把 `webRequested` 置回 false 释放它（见 `docs/REVIEW.md` 的"待办"）。
6. **pdf.js 是 3.11.174**（2023 年版本）。CVE-2024-4367 的缓解措施 `isEvalSupported:false`
   已经开着，但版本本身偏旧，升级前先按 `docs/SPIKES.md` 重跑导入验证。

## 8. 架构守卫脚本

`node tools/check-architecture.mjs`（CI 与本机都能跑，不需要鸿蒙 SDK）。检查四件事：

1. `logic/`、`data/` 不 import 任何 `@kit.*` / `@ohos.*`；
2. 这两层内部的相对 import 必须带 `.ts`（Node ESM 硬要求）；
3. `logic/` 只能依赖 `logic/`；
4. `data/` 只能依赖 `data/` 与 `logic/`。

为什么不用 `grep`：grep 只能看单行，而本仓库大量使用**多行 import**、`export * from './X'`、
`../` 跨层引用 —— 这三类正好是 grep 漏掉的（原 workflow 就是这么漏的）。脚本自己也验证过：
故意放一个违规文件进去，四类违规全部报错并返回 1。
