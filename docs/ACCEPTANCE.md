# 验收记录（阶段 4）

环境：Windows 11 + DevEco Studio 26.0.0 / SDK API 26 / hvigor 6.26.8；
设备：**Mate 90 Pro 模拟器**（x86 镜像，软件渲染，无 GPU 加速）；
对比基准：Android 版（Calss-Android）在同一台机器的模拟器上测得 178 ms / 9.68 MB / 零权限。

> 所有数字都是**实测**，不是估算。测法写在每一项下面，方便复现。

## 1. 冷启动

测法：`aa force-stop` → `hilog -r` → `aa start` → 取**进程第一条日志**（`APPSPAWN: AppSpawnChild`）
到 `WMSMain: NotifyCompleteFirstFrameDrawing` 的时间差，取 3 次。

| 环境 | 构建 | 各次（ms） | 中位数 |
|---|---|---|---|
| 模拟器（x86，软件渲染） | debug · 首帧就挂隐藏 WebView（加载 pdf.js） | 1042 / 1446 / 1223 | **1223** |
| 模拟器 | debug · WebView 常驻但停在 about:blank | 1102 / 1244 / 1095 | **1102** |
| 模拟器 | debug · WebView **用时才创建**（最终方案） | 698 / 737 / 660 | **698** |
| 模拟器 | release（AOT）· 懒创建 | 598 / 692 / 644 | **644** |
| **真机 Pura 70** | **debug** · 懒创建 | 403 / 395 / 372 | **395** |
| **真机 Pura 70** | **release（AOT）** · 懒创建 | 381 / 385 / 362 | **381** |

结论：
1. **只要 Web 组件在组件树里，进程启动就要为 ArkWeb 付约 0.4~0.5s**
   （日志里 `C04500/webview: CalculateActiveWebEngineVersion` 早于 `LoadModule`）；
   再让它真的加载 1.5MB 的 pdf.js，就再多 0.2~0.6s。
2. 所以最终方案是 **点「导入」时才创建 Web 组件**（`if (this.webRequested)`），
   并且 `src` 直接写 `resource://rawfile/pdfjs/viewer.html`（用 `$rawfile()` 或后置 `loadUrl`
   在这台设备上都会出问题，见下节）。
3. release 与 debug 差别不大 → **瓶颈不在 ArkTS 代码**，而在 ArkUI 引擎与模拟器的软件渲染。
   首帧不做任何数据库操作（`EntryAbility.onCreate` 为空，`aboutToAppear` 只是发起异步加载）。
4. **真机上量到了**（2026-10-26，Pura 70 / HarmonyOS 7.0 / API 26）：debug **395 ms**、
   release **381 ms**，比模拟器快约 1.8 倍。release 与 debug 只差 14 ms —— 再次说明启动开销
   主要不在 ArkTS 代码。
5. 与 Android 版那次 178 ms **不同设备、不可直接比较**：那个数字来自同一台 Windows 上的
   Android 模拟器，没有 ArkWeb 这种系统级浏览器引擎的初始化成本。同机对比得把 Android 版
   也装到这台手机上（目前没装）。

### 1.1 用完 pdf.js 就把 Web 放掉（`releaseWeb`）

导入结束（无论成功、超时还是抛错）之后 `releaseWeb()` 会：`webRequested = false`（组件离开组件树）
→ `webReady = false` → 换一个新的 `WebviewController`（旧 controller 绑的是已销毁的组件，
继续用只会丢回调）。

| 验的点 | 做法 | 结果 |
|---|---|---|
| Web 真的没了 | 导入一次真实课表 PDF（认出 14 门）后 `uitest dumpLayout` | **Web 节点数 = 0**（修前会留一个 1×1 的 Web） |
| **还能再导入**（这是这次改动唯一的真风险） | 同一次会话里再导入同一份 PDF | 仍然「网格式 · 认出 14 门课」，Web 节点再次 = 0 |
| 回调不会串 | 两次导入之间不去点「覆盖/合并」 | 第二次的 payload 仍属于第二个文件（`CLEAR_SCRIPT` 在 `extractPdfPayload` 里） |

冷启动数字**不作承诺**：模拟器上 9 次采样的跨度是 **711~1107 ms**（中位数 896），
比"Web 是否在树里"带来的 ~0.4s 差异还大 —— 也就是说这台软件渲染的机器测不出这个改动的收益。
能确证的只有上面三条（组件确实被销毁、且销毁后仍可重建）。

> 参考：修之前，**启动时就把 Web 挂在树上**的两次实测是 1223 ms（还加载 pdf.js）与 1102 ms
> （停在 about:blank），而对照片段"完全不带 Web"是 698 ms。释放之后，用户用完导入再启动，
> 走的就是"不带 Web"的那条路。
## 2. 体积

| 项 | 大小 |
|---|---|
| HAP（release，未签名） | **2.39 MB**（2,387,511 字节；含 3d 作息导入与 Web 释放，上一版 2,309,163） |
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
| Node 断言 | **295 条 / 19 套**（`node --test "tests/*.test.ts"`，不需要鸿蒙 SDK） |
| 架构守卫 | `logic/`、`data/` 零平台依赖、相对 import 带 `.ts`、不跨层（`node tools/check-architecture.mjs`，见第 8 节） |
| ArkTS 构建 | `BUILD SUCCESSFUL`（debug 与 release 都验过；**两种构建都装到真机 Pura 70 跑过**，release 的签名 HAP 2.43 MB / 未签名 2.39 MB） |
| CI | GitHub Actions：每次 push / PR 跑全部断言 + 架构守卫脚本 |

## 5. 功能覆盖（相对 Android 版）

| 功能 | 状态 |
|---|---|
| 周视图（7 列 × N 节、今天高亮、并排冲突、翻周、回到本周、详情卡） | ✅ |
| 「打开即当前周」两条抑制规则 | ✅ 11 个用例（其中 6 个是时序复演，共 28 处断言） |
| 多课表（列表/切换/新建/重命名/主课表/删除/启动开关） | ✅ |
| 作息编辑（改节次号/分组/起止时间、加一节、删一节自动重编号、恢复默认、从其他课表复制） | ✅ 与 Android 共用同一套编辑规则（`SlotDraft`）；实机改过 `8:5`→`8:05`、试过重号拒绝（`evidence/48~51`） |
| PDF 导入（选文件 → 预览 → 覆盖/合并/新建课表） | ✅ 真实课表认得 24 门；按「名称+教师+地点」归并成一门课多时段 |
| 新建/编辑课程（点空白格新建、点色块编辑·删除） | ✅ 实机建·改·删都验过（`evidence/32~35`） |
| 学期设置（开学日 / 总周数，周视图顶部进） | ✅ 实机改过 20 → 18 周（`evidence/34`） |
| 自定义安排（点空格选类型、新建/编辑/删除、详情卡） | ✅ 实机建·改·删 + 重启留存 + 周次掩码跨周验证（`evidence/39~47`） |
| 导入作息（三条通道 → 校对页 → 整表替换） | ✅ 三条通道都端到端验过：粘贴文本 / PDF（模拟器）、**图片 OCR（真机，相册真实作息表截图 → 12 节）**（`evidence/52~63`） |
| 图片 OCR 的真实识别效果 | ✅ **真机端到端验过**（Pura 70 / HarmonyOS 7.0）：相册选图 → 中文识别 → 作息解析（12 节全中、课间行跳过）→ 校对页 → 写库（§5.3） |

### 5.1 自定义安排的实机验证（逐条对应截图）

用 `real-check` 课表（真实 PDF 导入的 20 周、14 门课）在模拟器上跑了一遍完整流程：

| 验的点 | 做法 | 结果 | 证据 |
|---|---|---|---|
| 入口二选一 | 点周一第 1 节空格 | 弹出「周一 · 第 1 节 / 在这个时间段添加什么？/ 课程 · 自定义安排」 | `39-custom-event-entry` |
| 新建表单 | 选「自定义安排」 | 标题/备注/星期/起止节/周次齐全，默认 `1-20`（整学期） | `40-custom-event-form` |
| 落库并画进网格 | 标题「健身」→ 保存 | 周一 1-2 节出现灰褐色块 | `41-custom-event-saved` |
| 详情卡 | 点色块 | 时间（含 `8:00-9:35`）、周次、备注、右上角「编辑」 | `42-custom-event-detail` |
| 编辑回填 | 点「编辑」 | 标题/星期/节次/周次全部回填（`1-20` → 改过之后回显 `1-8`），底部有「删除该安排」 | `43-custom-event-edit` |
| 输入校验 | 周次填「乱写」→ 保存 | **不保存**；周次框描红，下方红字给出格式要求与自动纠正说明 | `44-custom-event-invalid-weeks` |
| 周次掩码真的生效 | 改成 `1-8` 保存后翻到第 8 / 第 9 周 | 第 8 周有、第 9 周没有（第 9 周是同格的另一门课） | `45-custom-event-conflict` |
| 与课程的冲突 | 第 8 周同格撞上「数字电子技术基础实验」 | 两块并排各占一半，各带 ⚠；详情卡写明「⚠ 与《…》时间重叠」 | `45-custom-event-conflict` |
| 重启不丢 | `aa force-stop` → `aa start` | 第 1 周仍有「健身」，进编辑还是 `1-8` | `46-custom-event-restart` |
| 保存后跳周 | 在第 1 周新建一条 `5-6` 周、周六 3-4 节的「社团」 | 保存后**自动跳到第 5 周**并显示它（否则用户会以为没保存上） | `47-custom-event-jump` |
| 两步删除 | 编辑 → 「删除该安排」→ 再按一次 | 第一下变红改成「再按一次删除这条安排」，第二下才删；删完网格立刻空出 | 同 `43` 的红态 |

### 5.2 作息编辑与作息导入的实机验证

同一台模拟器、同一张 `real-check` 课表（12 节作息），逐条对应截图：

| 验的点 | 做法 | 结果 | 证据 |
|---|---|---|---|
| 行内编辑 | 点第 1 节 | 弹窗带出节次号 `1`、分组「上午」、`8:00`/`8:45` | `48-slot-editor` |
| 节次号重复 | 把第 1 节改成 `2` 保存 | **不保存**，toast「第 2 节已经存在了，换个节次号」，弹窗不关 | `49-slot-duplicate` |
| 时间宽容解析 | 开始时间改成 `8:5` 保存 | 列表变成 `8:05 - 8:45 · 40 分`（自动补零并写库） | `50-slot-time-normalized` |
| 加一节 | 点「加一节」 | 弹窗预填 `13` / 「晚上」/ `22:20 - 23:05`（时长沿用上一节） | `51-slot-add` |
| 三条通道入口 | 作息页 → 「导入作息」 | 「识别图片（相册）/ 粘贴文本 / 从 PDF 文件」三个入口 + 用法提示 | `52-slot-import-channels` |
| 粘贴文本 → 校对页 | 贴 4 行 `1,8:00-8:45` …（每行要有节次号+起止时间） | 认出 4 节；带「当前作息有 12 节，这次只认出 4 节…」提示 | `53-slot-import-review` |
| 「补一节」与提示联动 | 校对页点「补一节」 | 多出第 3 节 `9:35-10:20`，且提示里的数字**跟着变成 3** | `53-slot-import-review` |
| 应用到课表 | 点「应用到课表」 | 回到作息页，列表只剩导入的 3 节（`uitest dumpLayout` 读到第 1~3 节）；toast「已导入 3 节作息」 | 同一次操作，见 `53` 之后 |
| PDF 文字层 | 选真实课表 `real-check.pdf`（2 页 / 207 个片段） | pdf.js 抽取出文字行（62 行），作息解析认不出 → 报错主语是「这份 PDF」而不是「图片」，并给出「查看识别原文（62 行）」 | `54-slot-import-error` |
| 图片通道 | 点「识别图片（相册）」 | 系统相册选择器打开（**零权限**）；取消后回到入口、**不弹错误** | `56-slot-image-picker` |
| 从其他课表复制 | 作息页 → 「从其他课表复制」 | 列出其他课表（重名时标「主」）；选一张 → toast「已复制 12 节」 | `55-slot-copy` |

> 图片 OCR 的**识别效果**在这台模拟器上验不了（系统镜像没有 OCR 后端）。代码路径已按
> `Core Vision Kit` 的 API 写完，失败分支在设备上走通过（错误码翻译成了可行动的话）。
### 5.3 真机上的图片 OCR（2026-10-26 · Pura 70）

这一条之前一直挂起（模拟器没有 OCR 后端）。真机上跑通了：

| 验的点 | 做法 | 结果 | 证据 |
|---|---|---|---|
| Core Vision Kit 可用 | 开发者入口 → 跑 spike | `typeof textRecognition = object`、`init() = true`、支持语言 `zh-CN, en, ja, ko, zh-TW` | `59-devpanel-ocr-device` |
| 中文识别 + 包围盒 | 同一按钮（内置 900×760 作息样图） | 4 块 / 161 字符 / **11 行带包围盒**，首行 `(52,41) 作息时间表(合成夹具)` | `59-devpanel-ocr-device` |
| OCR → 作息解析 | 同上 | **8 节**（第 1 节 8:00-8:45 … 第 10 节 19:50-20:35），并如实报告：2 行是课间已跳过、第 7/8 节没认出来 | `59-devpanel-ocr-device` |
| **生产路径**（不是 spike 的代码） | 开发者入口 → 「用内置作息样图跑「导入作息 → 识别图片」」（debug 专属入口） | 走的是 `Ocr.readLines`（解码 + EXIF + OCR）→ `TimetableTextParser` → **校对页**：认出 8 节、三条提示齐全、8 行可改 | `57-ocr-import-review-device` |
| 写库 | 校对页 → 应用到课表 | 作息页只剩这 8 节（第 1-6、9、10），与识别结果一致；随后「恢复默认 12 节」复原 | `60-slots-restored-device` |

**相册选图（补验，同一天）**：用户往相册里放了一张真实的《全校作息时间调整方案》截图（含
课间/大课间行），从「导入作息 → 识别图片（相册）」走完整条：

| 验的点 | 结果 |
|---|---|
| 相册选图 → 读像素 | 通过。`photoAccessHelper` 给的 media URI 能被 `fileIo.openSync` 打开并解码成 PixelMap |
| 识别 | **12 节全中**，时间一字不差（8:00-8:45 … 20:50-21:35）；9 行课间/大课间**被正确跳过** |
| 推断标注 | 第 1、2 节的序号格没读出来 → 按上下顺序推断，界面上打「推断」标记让人核对 |
| 写库 | 应用后作息页就是这 12 节（13:30/14:20/15:30… 与截图一致）→ `63-slots-from-ocr-device` |

### 5.4 真机上发现的一个真 bug：中文文件名变成百分号编码

真机上第一次选 PDF 导入课表时，面板里显示的文件名是
`%E5%88%98%E5%88%A9%E4%BA%9A(2026-2027-1)%E8%AF%BE%E8%A1%A8%20(1).pdf`。

原因：`DocumentViewPicker` 回传的 uri 里中文是百分号编码的，`PdfFile.baseNameOf` 只做了
"取最后一段"，没解码。这个值还喂给「导入为新课表」的默认表名，所以会一路脏下去。
模拟器上那份文件叫 `real-check.pdf`（纯 ASCII），一直没暴露。

修法：`decodeURIComponent`，并对残缺的 `%` 兜底（解码失败就用原串，不能因为文件名让导入失败）。
修完再走一次：面板显示 `刘利亚(2026-2027-1)课表 (1).pdf`，仍认出 14 门课。

> 顺带确认：**课表 PDF 导入在真机上也能跑**（pdf.js + ArkWeb），14 门课与模拟器上一致，
> 合并进课表后网格正常（`62-grid-after-import-device`）。

## 6. 踩过的平台坑（都花了实机调试时间，记下来）

0. **文件选择器回的 uri 里中文是百分号编码的**（真机实测）：`DocumentViewPicker` 给的是
   `.../%E5%88%98%E5%88%A9%E4%BA%9A(2026-2027-1)%E8%AF%BE%E8%A1%A8%20(1).pdf`。
   直接取末段当文件名，界面上就是那串 `%E5%88...`，还会传染给「导入为新课表」的默认表名。
   要么 `decodeURIComponent`（并对残缺的 `%` 兜底），要么别拿 uri 当文件名用。
   模拟器上那份 PDF 叫纯 ASCII 名字，所以这个坑只有真机才踩得到（§5.4）。

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

## 6.5 真机验证（2026-10-26 · HUAWEI Pura 70 / HarmonyOS 7.0.0）

| 项 | 值 | 怎么得到的 |
|---|---|---|
| 设备 | HUAWEI Pura 70（ADY-AL00），序列号 2MH0224627004255 | `hdc shell param get const.product.model` |
| 系统 | **HarmonyOS 7.0.0.109(SP6C00E105R5P2)** / OpenHarmony-7.0.0.105 | `param get const.product.software.version` / `const.ohos.fullname` |
| API | **26**（与本工程 `compatibleSdkVersion` 一致） | `param get const.ohos.apiversion` |
| 屏幕 | 1256 × 2760 | `snapshot_display` |
| 安装 | `entry-default-signed.hap` → `install bundle successfully` | `hdc install -r` |

**第一次是装不上的**，两个卡点都值得记：

1. 上一台接上来的是 nova 12 Ultra / HarmonyOS **4.2**（Android 内核）：`adb devices` 能看到，
   `hdc list targets` 是 `[Empty]`。4.2 只能跑 APK，HAP 装不上去。
2. 这台 Pura 70 是纯血鸿蒙、API 也对，但 `hdc install` 直接拒绝：
   `code:9568320 error: no signature file`。真机验签是硬性的，`bm install` 没有任何跳过开关；
   必须用 DevEco 的「自动签名」生成调试证书 + profile（profile 绑定设备 UDID，只能在线申请）。
   签完 `build-profile.json5` 里的 product 还要加一行 `signingConfig: "default"`，
   否则 hvigor 仍然只产出 `entry-default-unsigned.hap`（日志：`WARN: No signingConfig found`）。

> 签名材料在 `%USERPROFILE%\.ohos\config`，含个人证书与口令，**不进仓库**；
> 换机器/换设备时在 DevEco 里重新勾一次自动签名即可。

## 6.6 上一台设备为什么没做成（2026-10-25 留档）

用户接了一台真机上来，结果**装不进去**，原因值得记一笔：

| 项 | 实测值 | 怎么得到的 |
|---|---|---|
| 设备 | HUAWEI nova 12 Ultra（ADA-AL00U / ADL-AL00U） | `adb devices -l` |
| 系统 | **HarmonyOS 4.2.0**（EmotionUI 14.2.0，底层 Android 12 / API 31） | `getprop ro.build.version.release` / `ro.build.display.id` |
| hdc | `hdc list targets` → **`[Empty]`** | hdc 只认纯血鸿蒙（NEXT）设备 |
| adb | `adb devices` → `2UCUT24328002862  device` | 4.2 是 Android 内核版，走 adb |
| 本工程的兼容级别 | `compatibleSdkVersion: "26.0.0"`（HarmonyOS 7.0 / API 26） | `build-profile.json5` |

结论：**HarmonyOS 4.x 用 adb、跑 Android APK；HAP 只能在纯血鸿蒙（NEXT）上装**，
而本工程的最低 API 是 26。所以那台机器连"装上"这一步都做不到，与代码无关。

要在真机上验，需要满足以下之一：

1. 一台纯血鸿蒙设备，且系统版本 ≥ 本工程的 `compatibleSdkVersion`（API 26）；
2. 或者把 `compatibleSdkVersion` 降到目标设备支持的级别再构建 —— 这会新开一个
   "兼容低版本"的分支，并逐个确认用到的 API 在那一版存在（可能要去掉个别新 API）。

在拿到这样的设备之前，**「图片 OCR 识别效果」与「真机冷启动」两条只能继续挂起**；
模拟器上的结论（295 条断言、冷启动 698 ms/644 ms、各功能实测）保持有效。

### 6.7 真机上多踩的两个小坑

1. **`hdc list targets` 一开始是 `[Empty]`，重启 hdc server 才枚举到设备**
   （`hdc kill` → `hdc start` → `2MH0224627004255` 出现）。
   同时 `Get-PnpDevice` 里能看到 `HDC Device (VID_12D1&PID_5000)` —— 说明设备和驱动没问题，
   是 server 侧的枚举卡住了。上一次同样的现象发生在 HarmonyOS 4.2 那台机器上，
   那次是真的不支持（只能用 adb），两者要分清。
2. **`uinput -T -m` 的滑动参数是 4 个坐标**（`-m x1 y1 x2 y2`），写成两段会报
   `wrong number of parameters: 5`；要用滑动优先 `uitest uiInput swipe x1 y1 x2 y2 [ms]`。
3. 用 `uitest dumpLayout` 取坐标前先确认**当前前台是我们的应用**：一次连点标题时，
   屏幕上正好压着一条微信通知，5 次点击把微信点开了。之后改成先 dump 出标题的
   `bounds` 再点它的中心。
### 6.8 真机上"文字图标"不渲染（U+2039 / U+203A）

周次条左右两个切换按钮原来是 `Button('‹')` / `Button('›')`。**模拟器上正常，真机上是一个
什么都没有的白圆圈** —— 系统给 Button 用的字体回退里没有这两个字符（General Punctuation）。
同一段文字放在 `Text` 里却能显示（`‹ 返回` 一直好的），所以问题不在字符本身，而在控件用哪套字体。

修法：不再拿字符当图标，改成两个 SVG（`app.media.ic_chevron_left/right`）+ `Image`，
禁用态用 `opacity(0.3)` 而不是换颜色。顺手把其它"靠字符表意"的地方也换掉了，
免得下一个设备再踩：

| 原来 | 现在 | 原因 |
|---|---|---|
| `学期设置›` | `学期设置` | 同上，`›` 可能整段消失 |
| `⚠ 与《…》时间重叠`、格子角上的 `⚠` | `!` | 警告符号在部分字体里是彩色 emoji，落在中文正文里样式会跳 |
| 课程编辑面板删时段的 `×` | `删` | `×`（U+00D7）虽常见，但中文界面里换成字更稳 |
| `900×760` | `900x760` | 同上，ASCII 最保险 |

### 6.9 CSP 与 resource:// 页面（加安全策略时踩的）

给 `viewer.html` 加 CSP（`default-src 'none'`）之后，导入**静默变成"回传头 null"**：

- `script-src 'self'` 在 `resource://rawfile/...` 页面上**不匹配**任何外部脚本，
  `pdf.min.js` 被拦 → `pdfjsLib` undefined → 内联脚本在 `pdfjsLib.GlobalWorkerOptions` 那一行就抛，
  `window.__runExtract` 根本没定义；
- `runJavaScript` 调一个不存在的函数**不报错**，只回传 `null`（四个字符）；
- 旧代码只判空串，于是 `"null"` 被当成解析结果 —— 界面报「无法识别的回传头: null」，
  每次 force-stop 重来又可能"自己好了"（页面加载时序不同），极难定位。

现在的写法（三处一起改，缺一条就还会复发）：

1. CSP 用 `resource:` 而不是 `'self'`：
   `script-src 'unsafe-inline' 'unsafe-eval' resource: blob:`、`worker-src resource: blob:`、
   `connect-src resource: data: blob:`、`font-src resource: data: blob:`；
2. `viewer.html` 里 `typeof pdfjsLib === 'undefined'` 时直接回 `ERR`，把原因写进 payload；
3. ArkTS 侧把 `null` / `undefined` 当"还没有值"（`Index.valueOrEmpty`），
   并在解析前探一下 `typeof window.__runExtract` —— 不是 `function` 就明确报"解析器页面没就绪"。

### 6.10 "截图式 PDF"（每格只有课名 + 教室）

`spike-timetable.pdf` 这类"把截图另存为 PDF"的课表没有 `(N-M节)1-16周/教室/老师` 详情行，
`GridFormatParser` / `ListFormatParser` 都认不出（格子被当成"只有课名"跳过）。
现在第三条兜底：把 pdf.js 的 run 当 OCR 行喂给 `GridFromOcr`（它本来只吃"文字 + 包围盒"），
于是同一套网格还原逻辑两处复用。实测模拟器上认出了 3 门课，并且如实给出
"没认出节次列，已按顺序编号"、"截图里没有周次，按整学期导入"两条警告。

同一个模块在真机截图验证时踩到过两个必须记住的坑（`tests/grid-from-ocr.test.ts` 已钉住）：

- `实验室503-504` 这种门牌被当成 `3-50 周` → **周次必须带"周"字**，且范围要在 1..MAX_WEEK；
- 表头上方的「2026 春季学期课表」被当成一门课 → 表头以上的行一律不算课程；
  同理，格子里**教室排在课名上面**时（`1-101` / `高等数学`），不能拿第一行当课名。

## 7. 遗留风险

1. **冷启动只在模拟器上量过**，真机未测（模拟器是软件渲染，数字偏悲观）。
2. **PDF 导入的解析正确率**只在 1 份真实课表上验过（24 门）。不同学校的版式差异大，
   解析器是"尽力而为 + 预览确认"的设计，不会静默写错。
3. **图片 OCR 的识别效果没验**（模拟器无后端，1001400001）。通道本身已实现：能开相册、取消不算错误、失败给可诊断的话，这三条在设备上验过；识别准不准只能等真机。
4. 冲突格的并排显示在窄列下文字会竖排（与 Android 版一致的既有行为）。
5. ~~pdf.js 的 Web 组件用过之后常驻~~ —— **已修**：`releaseWeb()` 在抽取结束后销毁 Web、把 `webReady` 置回 false、并换一个新的 `WebviewController`。实测导入后组件树里 **0 个 Web 节点**，且同一次会话里**再导入一次仍然成功**（见 §1.1）。
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
