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
| 设备侧 `bm dump -n com.calss.jiankebiao` | `reqPermissions: []`、`reqPermissionStates: []`、`permissions: []` |
| 文件选择 | 走系统 `DocumentViewPicker`，**不需要**任何读存储权限 |

即：与 Android 版一样是**零权限**应用。

## 4. 测试与构建

| 项 | 结果 |
|---|---|
| Node 断言 | **355 条 / 24 个文件**（`node --test "tests/*.test.ts"`，不需要鸿蒙 SDK；354 通过 + 1 跳过 —— 跳过的那条要有真机 OCR 后端才跑） |
| 架构守卫 | `logic/`、`data/` 零平台依赖、相对 import 带 `.ts`、不跨层（`node tools/check-architecture.mjs`，见第 8 节） |
| UI 规范守卫 | 无小于 8fp 的字号（`node tools/check-ui.mjs`，见第 9 节；这一条是 2026-11 上架自检判"不通过"后补的） |
| ArkTS 构建 | `BUILD SUCCESSFUL`（debug 与 release 都验过；**两种构建都装到真机 Pura 70 跑过**，0.1.2 release 签名 HAP 的体积见 `dist/` 与 `docs/SIGNING.md`） |
| CI | GitHub Actions：每次 push / PR 跑全部断言 + 架构守卫脚本 |

## 5. 功能覆盖（相对 Android 版）

| 功能 | 状态 |
|---|---|
| 周视图（7 列 × N 节、今天高亮、并排冲突、翻周、回到本周、详情卡） | ✅ |
| 「打开即当前周」两条抑制规则 | ✅ 11 个用例（其中 6 个是时序复演，共 28 处断言） |
| 多课表（列表/切换/新建/重命名/主课表/删除/启动开关） | ✅ |
| 作息编辑（改节次号/分组/起止时间、加一节、删一节自动重编号、恢复默认、从其他课表复制） | ✅ 与 Android 共用同一套编辑规则（`SlotDraft`）；实机改过 `8:5`→`8:05`、试过重号拒绝（`evidence/48~51`） |
| PDF 导入（选文件 → 预览 → 覆盖/合并/新建课表） | ✅ 真实课表认得 24 门（模拟器）/ 14 门（真机与模拟器一致：2 页、`UniGB-UCS2-H`、无 ToUnicode）；**文字层为空的 PDF 走"渲染成图 + 设备端 OCR"兜底**（§6.15） |
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

### 6.11 教务系统导出的「.xls」其实是 HTML 表格

学生课表的 `.xls` 多数不是 Excel 二进制，而是**教务系统拼出来的 HTML 表格**（UTF-8 或 GBK）。
拿它当 Excel 读会报错，拿它当 PDF/截图也走不通，所以单开一条通道
（`logic/HtmlTable.ts` + `logic/JwxtTableParser.ts` + `platform/TableFile.ts`）。

实测（某校真实导出，39 个课程块 / 8 处停课 / 11 节作息）踩到的六件事：

1. **`<table>` 与 `</table>` 不配对**：4 个开标签只有 2 个闭标签（浏览器会自动补）。
   按"深度计数"切表时，第二个表里一个没闭合的内层 `<table>` 会让深度永远回不到 0，
   后面的表全丢 —— 现象是"只解析出 1 个 3×8 的小表"，极容易被误判成解析器没写对。
   改成"从 `<table` 到最近的 `</table>` 或下一个 `<table`"。
2. **停课行长得像周次行**：`(4  停课(本部))` 以数字开头，按周次解析会得到"第 4 周有课、没教室"，
   而真实含义正好相反。必须**先认"停课"**，再把那一周从掩码里减掉（实测 8 处）。
3. **一格塞好几门课**：同一门课的一周两次也在同一格里各写一遍，各自带周次与教室。
   所以解析是"逐块"的，不能假设一格一门课。
4. **周次写法五花八门**：`[1-4]`、`[6-16]双`、`[9-17]单`、`[1-4],[6-13]`、`[1-2],[5-17],19`、`5`。
5. **rowspan 决定节次范围**：`第一节`格的课 `rowspan=2` → 1-2 节。按行标签映射，不按顺序猜。
6. **文件底部还有作息时间表**（`第一节 08:00~08:45`），顺手一起解析；但**不自动写**
   —— 写作息是整表替换，预览里给一个「一并导入作息」按钮，用户点头才写。

验证分两层：合成夹具（`tests/fixtures/jwxt-sample.html`，姓名课程全假）进仓库跑 CI；
真实导出文件放在 `tools/fixtures/`（**含学号姓名，不入库**），存在时跑完整数字断言
（31 个非停课块 → 12 门课、11 节作息），不存在时 skip。

### 6.12 「签名已经做过了」不等于「能上架」

DevEco 的自动签名签出来的是**调试包**，应用市场不收。判别方法不是看界面勾没勾，
而是用 SDK 的 `hap-sign-tool.jar verify-app` 回读**包内真实生效**的 profile：

| 字段 | 自动签名（调试） | 应用市场签发（发布） |
|---|---|---|
| `type` | `debug` | `release` |
| `bundle-info` 里的证书 | `…,Development` | `…,Release` |
| `debug-info.device-ids` | 一台设备的 UDID 白名单 | **没有** |
| `app-distribution-type` | 无 | `app_gallery` |

`tools/sign-release.mjs` 就是干这件事的：用发布材料调 `sign-app` 重签，再用
`verify-app` 回读并断言，任一条不满足就删产物、退出码 1（不会给你一个"看着像能上传"的包）。

本次实包验证（2026-11-10，`dist/jiankebiao-release-signed.hap`，2.30 MB）：

```
Find Hap Signing Block success, version: 3, block count: 3
profile type is: release
Subject: CN="李浩阳(2069735078807744833)\,Release", OU=2069735078807744833, O=李浩阳, C=CN
Validity: 2026-11-10 20:20:24 ~ 2029-11-10 20:20:24
Subject: CN=Huawei CBG Developer Relations CA G2, …      （中间 CA）
Subject: CN=Huawei CBG Root CA G2, …                     （根）
Digest verify result: true, DigestAlgorithm: SHA-256
verify-app success
```

包内 `module.json`：`bundleName com.calss.jiankebiao` / `versionName 0.1.0` /
`versionCode 1000000` / `debug false` / `buildMode release` / `minAPIVersion 50002014`，
且解包后**没有** `*.map`、`*.ts` 之类调试残留。

> 这一步只证明"包本身合格、签名类型正确"。**装上去能不能跑**当时没验（真机未连）；
> 2026-11-11 已在模拟器上补验（见 §6.14：卸载调试包后发布包能装、能启动）。
> 应用市场的合法性/自检结果仍以 AGC 服务端为准。

### 6.13 应用市场只收 `.app`，而且 hvigor 不收明文口令

「上传新版本」那个框写的是「支持 APP 格式，大小在 4 GB 以内」——要 **App Pack（`.app`）**。
两件事是实测出来的：

1. **`.app` 里的 HAP 是未签名的**。用 `tar` 把 DevEco 自己产出的 `*-signed.app` 拆开，
   里面的 `entry-default.hap` 用 `verify-app` 读会报 `No Hap Signing Block before ZIP Central Directory`
   —— 签名对象是整个 zip（`sign-app -inForm zip`），容器内的 HAP 不需要单独签名块。所以不要
   看到"内部 HAP 没签名"就以为出包失败。
2. **`build-profile.json5` 里塞不进明文口令**。手写一个 release 的 signingConfig 后构建直接拒：
   ```
   00303116 Configuration Error
   The length of the storePassword or keyPassword field in the signature configuration is less than 32.
   ```
   hvigor 只认 DevEco 用本机密钥加密过的串。所以要么走 GUI 让它加密，要么直接调
   `hap-sign-tool.jar sign-app`（`tools/sign-release.mjs` 走的就是这条路）。

本次 `.app` 实包（0.1.0 当时是 `dist/jiankebiao-0.1.0-release.app`，0.95 MB；
0.1.1 重出后为 `dist/jiankebiao-0.1.1-release.app`，996,818 B，
sha256 `5be2fe8550beabf0d4b01102e1adaf85f20cf1caee5b78895c551ab274d4a057`），
`sign-app -inForm zip` 签完后 `verify-app` 回读：
`type=release`、`bundle-name=com.calss.jiankebiao`、`app-distribution-type=app_gallery`、
无 `device-ids`、证书链 `根 CA G2 → 开发关系 CA G2 → …Release`、`Digest verify result: true`；
容器内 `entry-default.hap` 的 `module.json` 为 `buildMode release` / `debug false` /
`versionCode 1000001` / `minAPIVersion 50002014`。

### 6.14 上架自检报了 4 条 UX：1 条「不通过」、3 条「警告」

包 0.1.0 / 1000000 传进 AGC 跑「上架自检」，UX 维度回来这 4 条（原文照抄）：

| 维度 | 检查项 | 发生次数 | 结果 |
|---|---|---|---|
| UX · 字体 | 应用的文字大小需满足最小字号要求：文本字号不小于 12 fp（推荐），最小不得小于 8 fp（必须） | 2 | **不通过** |
| UX · 转场动效 | 建议使用系统转场，页面转场采用淡入淡出的运动方式，不应单帧直接切换、左右平移或者上下位移切换，曲线优先使用弹簧曲线 | 7 | 警告 |
| UX · 滑动动效 | 界面滑动到边界位置时（上下滑动到顶部或底部，左右滑动到左边界或右边界），应该有反馈动效 | 2 | 警告 |
| UX · 转场动效 | 全屏页面的转场（层级转场、新建转场、编辑转场、搜索转场等）动效时长：8.5 英寸及以下 ≥200 ms；8.5~12 英寸 ≥250 ms；12 英寸以上 ≥300 ms | 6 | 警告 |

三条根因，全都是"能跑起来"根本看不出来的：

1. **一个 7fp 的字**。`view/WeekGrid.ets` 节次列里的钟点小字（"8:00 / 8:45"）是从 Android
   版照搬的 `fontSize(7)` 配 `lineHeight(8)` —— 当时只想着"34vp 的窄列塞得下"。自检按 8fp
   划线，直接判不通过。窄格字号 `CellLayout.NARROW_FONT_SIZE = 8` 也正好压在线上（8 是"必须"
   档，一点余量都没有）。
2. **本应用其实没有"页面转场"**。整页是"一个 `@Entry` 页面 + `screen` 三态 + 十来个全屏卡片"，
   切换全靠 `if` 直接增删节点 —— 那就是"单帧直接切换"，动效时长实测 0 ms，于是两条转场规则
   同时命中（7 次 / 6 次）。当初"少一层导航"的省事，代价正好落在自检上。
3. **滚到边界是硬停**。`Scroll` 的 `edgeEffect` 默认 `EdgeEffect.None`（`List` 才是 `Spring`），
   周视图滑到顶/底没有任何反馈。

修法（重新出包，版本升到 0.1.1 / 1000001 —— 应用市场按 versionCode 去重，不升号会被
"该版本已存在"挡回来）：

1. **字号**：7fp → `CellLayout.GUTTER_TIME_FONT_SIZE = 9`（行距 11；34vp 列宽里 "10:40" 约
   23vp，放得下）；窄格 8 → 9。并把"不许低于 8fp"变成三道闸：
   - 常量 `CellLayout.MIN_FONT_SIZE = 8`（注释写明它等于自检的"必须"档）；
   - `tools/check-ui.mjs`（`npm run check:ui`，已并入 `npm run check`）：扫全部 `.ets` 的
     `.fontSize(n)` / `.font({size:n})` / `.fontSize('7fp')`，出现 <8fp 直接失败；
   - `tests/cell-layout.test.ts` 两条断言：一条钉住三个字号常量，一条把 6 高度 × 6 宽度 ×
     4 字体缩放的组合全跑一遍，断言算出来的 `nameFontSize ≥ 8`。
2. **转场**：新增 `view/Motion.ets`，实质只有一行
   `TransitionEffect.OPACITY.animation({ duration: 300, curve: Curve.Friction })`，挂到
   16 个"页面/全屏弹层"根节点（主屏 + 三个屏 + 十二个全屏卡片/面板）。**只做透明度**
   （规范原话是"淡入淡出"）、**300 ms**（设备类型含 phone/tablet/2in1，最严一档 250 ms）、
   **`Curve.Friction`**（系统摩擦/阻尼曲线）。没有用 `curves.springMotion()` 的 `ICurve`：
   它自带内部时长、会覆盖调用处的 `duration`，自检量到的时长就不受控了。
   另外三个屏从"`Column` 里的 if 分支"改成"`Stack` 里的 if 分支"：否则旧页淡出期间仍占位，
   新页会被排到它下面（切换瞬间整个界面下跳一下）。
3. **滑动**：所有可滚动容器显式 `.edgeEffect(EdgeEffect.Spring)`（周视图、作息列表、导入校对
   列表、识别原文、复制作息、课表列表、两个编辑面板的 Scroll）。`List` 本来就是 Spring，显式
   写出来是为了让"到边界有反馈"在代码里看得见。

证据：

- **转场真的在动**：把 `FADE_MS` 临时改成 2000 ms 重新出包，点「作息」后连拍，抓到"周视图与
  作息页同时半透明"的一帧（`docs/evidence/70-crossfade-2s-probe.jpeg`），下一秒的稳定帧是
  `71-transition-result.jpeg`。为什么要把窗口放大到 2 s：300 ms 内 `snapshot_display` 抓不到
  中间态。这不改结论 —— 只证明挂点生效、且确实是透明度交叉淡化。
- **字号**：`node tools/check-ui.mjs` →
  `扫描 7 个 .ets，无小于 8fp 的字号（推荐 12fp，低于推荐值的 55 处仅提示）`；
  设备侧 `uitest dumpLayout` 实测钟点文本 bounds `[20,1152][100,1230]`，宽 80 px（≈22.5 vp）
  落在 121 px（34 vp）宽的节次列内，两行都没被裁。
- **发布包能装能跑**：卸载调试包后 `hdc install dist/jiankebiao-0.1.1-release-signed.hap` →
  `install bundle successfully`；`aa start` 后 `pidof` 有进程（8505），首屏正常（空课表 + 12 节）。
  之前一次 `install … sign info inconsistent` 不是包不合格，而是**设备上已装着调试签名的同一
  bundle** —— 先卸载再装就好了。
- 版本一致性：`app.json5` 0.1.1 / 1000001，`.app` 内 `pack.info` 与 `module.json` 一致
  （`tools/sign-release.mjs` 断言，不一致会删产物并退出 1）。

**仍未验**：这三条警告改完能不能全过自检，只能再传一次（自检在服务端跑）；真机依旧没连上，
以上装机结论都来自模拟器（1280×2832、API 26）。

> 一个反直觉的观察：装好的发布包用 `bm dump -n com.calss.jiankebiao` 看，`appProvisionType`
> 是 `debug`、`appDistributionType` 是 `none`、`appId` 后缀为空；而同一份包用 `verify-app` /
> `verify-profile` 回读是 `type=release` + `app-distribution-type=app_gallery` +
> `app-identifier=6917621438836886292`。说明**模拟器的 `bm dump` 不能当签名判据**，判据只有
> 包内 profile（`verify-app`）与 AGC 自检结果。

### 6.15 审核又退回三条：导入"测不到"、PDF 解析器"没就绪"、PDF"没有可读文本"

包 0.1.1 / 1000001 的审核结果（原文照抄）：

| # | 审核原文 | 性质 |
|---|---|---|
| 1 | 「应用从教务系统表格导入课表功能需使用网页表格导致未完全遍历，无法测试，我们无法审核应用内相关功能与内容。」建议提交"有效可用的账号和登录信息" | 真问题（**但不需要账号**，见下） |
| 2 | 「应用存在文字大小不满足最小字号要求问题」，列了 9 个 7.00fp 的 Text（坐标 25,1006…） | **0.1.0 那次的旧报告**，0.1.1 已修（§6.14） |
| 3 | 「应用存在功能异常问题」①主页-作息-导入作息-从PDF文件：PDF 文件有内容，提示解析失败，没有可读文本；②主页-导入-从PDF文件：提示解析器页面没就绪，请重试 | 真问题（两个独立原因） |

四个根因，都不是"跑一遍演示"能看出来的：

1. **就绪判据判错了对象（竞态）**。`PdfScripts.READY_SCRIPT` 原来看 `window.pdfjsLib`，
   而入口函数 `__runExtract` 在**后面**的内联脚本里才定义 —— 中间隔着 `cmaps-data.js`
   （182KB 字面量）的解析。也就是说"就绪"为真之后，还有一段**入口函数不存在的窗口**，
   紧接着的探针就报「解析器页面没就绪（入口函数不存在）」。设备实测这个窗口 **7~11 ms**
   （模拟器，`hilog` 里的 `[pdfjs] 就绪窗口 11ms`），而探针在轮询命中后立刻执行 ——
   真机冷启动 JS 更慢，窗口更宽，审核第一次点导入就撞上了。
2. **内联的 CMap 只有 5 个名字**。中文 PDF 的 `/Encoding` 是 CID 字体 + 无 ToUnicode 时必须
   加载预定义 CMap 才能把字形码翻成汉字；名字不在内联表里 → pdf.js 加载失败 →
   `getTextContent()` 返回 **0 个片段** → 界面就是「没有可读文字」。原来内联表只有
   `UniGB-UCS2-H/V`、`UniGB-UTF16-H`、`GBK-EUC-H`、`Adobe-GB1-UCS2` 五个，而中文 PDF 常见
   `GBKp-EUC-H`（方正/老教务系统）、`GBK2K-H`、`GBT-EUC-H`、`UniGB-UTF8-H`…。
   实测同一份真实课表 PDF：**不给 CMap 时 `pages=2 totalItems=0`；给全量 CMaps 时
   `readable=207`** —— 这就是审核看到的那句话的来源（同类文件，未取到审核员的原件）。
3. **有些 PDF 根本没有文字层**：扫描件（整页就是一张图）、表单域里放表格的 PDF。
   这类文件任何文本抽取器都取不到字，原来只会报"没有可读文本"然后结束 —— 用户/审核
   无路可走。
4. **导入这条路对审核员是断的**：应用没有任何账号（也不需要），但三条导入通道都要求
   **外部文件**，审核员手上没有教务系统导出文件也没有课表 PDF，于是"导入"整条功能
   永远遍历不到 —— 他的结论自然只能是"无法审核"。

修法（版本升到 0.1.2 / 1000002，理由同 §6.14：市场按 versionCode 去重）：

1. **就绪判据改认入口函数**：`READY_SCRIPT` = `typeof window.__runExtract === "function"`；
   探针再包一层 **6 秒重试**（`ensurePdfReady`），窗口再宽也不会一次不等就报错。
2. **CMap 补到全量 GB 系列**：33 个（`UniGB-*`、`GB*`、`GBT*`、`Adobe-GB1-*`），
   raw 285KB / base64 390KB；生成脚本入库（`tools/make-cmaps-data.mjs`，数据源
   `pdfjs-dist@3.11.174` 的 `cmaps/*.bcmap`，与包内 `pdf.min.js` 同版本）。
3. **OCR 兜底**：文字层为空时，用 pdf.js 把页面**渲染成 PNG**（1400px 宽、白底）→ 写进
   cacheDir → 交给系统 OCR（`Ocr.readLines`，与「识别图片」同一套）→ 按页解析。
   课程导入按页跑 `GridFromOcr` 再合并（两页拼一张图会让表头行错位），作息导入按页
   拼 y 偏移（`PdfPageImages.stackPages`）后交给 `TimetableTextParser`。
   最多 3 页（每页一次完整 OCR），超出的页在预览里明说"只识别了前 3 页"。
4. **让导入可被遍历**：`导入` 面板加「示例：表格课表」「示例：PDF 课表」，`导入作息`
   面板加「没有文件？用内置示例作息表试试」——三个示例都是**随包发布的合成数据**，
   走的是**同一条生产代码路径**（`runTableImportFromRawSample` / `importPdf` /
   `importSlotsFromPdf`），只有"文件从哪来"不同。审核信息里填的步骤也就三行（见
   `store/README.md`）。

证据：

- **真实课表 PDF 真的能导**（未提交，只在本机/模拟器用）：把 `刘利亚(2026-2027-1)课表 (1).pdf`
  临时打进 rawfile，走 debug 入口跑生产路径 → 预览「网格式 · 认出 **14 门课**」，
  周次/节次齐全（`算法分析与设计 · 周1 3-4 节 · 1-16`、`离散数学（A） · 周2 3-4 节 · 1-12`…），
  与 `docs/REVIEW.md` 里记录的 22 格 → 14 门一致。该文件 `/Encoding` 是 `UniGB-UCS2-H`
  + `STSong-Light`、无 ToUnicode，2 页。
- **图片版 PDF 的渲染链路真的通**：`image-timetable.pdf`（整页一张图，`totalItems=0`）
  → 预览报 OCR 不可用之前，`cacheDir/pdf-page-1.png` 已生成：**1400×1866、267,175 字节**，
  拉回来肉眼看是清晰的课表网格（渲染在白底上、字没糊）：`docs/evidence/72-pdf-page-render.png`。
- **作息 PDF 通道**（以前只能靠"选文件"验、从没端到端跑过）：内置文字层样张
  `sample-slots.pdf` → 校对页「认出 10 节（内置示例 PDF）」，上午/下午分组与起止时间
  全部正确，并给出"当前作息有 12 节，这次只认出 10 节"的核对提示。
- **断言**：355 条（354 通过 + 1 跳过）。新增 `tests/pdf-page-images.test.ts` 7 条
  （渲染回传格式、页数上限、跨页 y 偏移、**`viewer.html` 与 `PdfScripts` 的全局名契约**）
  与 `pdf-run-text.test.ts` 2 条（`hasNoTextLayer` 正例：两种空文字层表现；反例：
  加密/损坏/超时**不**触发 OCR 兜底）。
- **审核报的那条 ②**：修复后冷启动第一次点导入即成功（模拟器上连跑 5 次，含强制停止后
  重进），`hilog` 里 `就绪窗口 7~11ms` 说明旧判据的窗口确实存在，新判据不看它。

顺手抓到的第五个 bug（只有按"真实使用顺序"点才会出现，release 包冒烟时撞上的）：

> **上一份文件的作息会漏到下一份文件的预览里**。`importSlots`（表格通道解析出的作息）
> 只在表格入口被赋值和清空；PDF / 截图入口不清。于是"导入表格（带 4 节作息）→ 取消 →
> 导入 PDF"时，PDF 的预览里仍然有「表格里还有 4 节作息」和「一并导入作息」，点一下就把
> **上一个文件的作息**写进库 —— 静默写错数据。修法：三个入口（PDF / 截图 / 内置 PDF 样张）
> 都在重置预览状态时一并 `importSlots = []`；实测同一顺序复现后不再出现该按钮。

- **发布产物（0.1.2 / 1000002）**：`dist/jiankebiao-0.1.2-release.app` 1,179,154 B ·
  sha256 `b991a333f080ae4a431f2e6db6da8bed108db4a8a65aa351a855f142f7220452`（`verify-app`：
  release / app_gallery / 0.1.2·1000002）；`dist/jiankebiao-0.1.2-release-signed.hap` 2,743,355 B ·
  sha256 `acf2d742de287090fd7747c37d9a3d5b8ae81d4a5bde6ee7e16385dd9438845b`。
  比 0.1.1 大了约 0.3 MB：全量 GB CMap（base64 390KB）+ 两个合成的 PDF 样张。

**仍未验 / 要说清的**：- **PDF→图→OCR 的识别质量**：这台模拟器没有 OCR 后端（`1001400001`），识别那一步只能在
  真机跑。能证明的是链路（渲染 → 落盘 → 调用 OCR → 报可诊断的错）与解析器（同一套
  `GridFromOcr` / `TimetableTextParser`，图片通道已在 Pura 70 真机验过 12 节，见 §5.3）。
- **审核员那份 PDF 到底是什么类型**，只能从他给的描述推断；上面三条路（CMap 缺失、
  扫描件、表单域）现在都被覆盖。
- 审核退回的第 1 条要"账号和登录信息"：本应用**没有账号体系**，这个字段应填"无需登录"，
  并把内置示例的路径写进"测试信息"。

## 7. 遗留风险

1. **冷启动只在模拟器上量过**，真机未测（模拟器是软件渲染，数字偏悲观）。
2. **PDF 导入的解析正确率**只在少数真实课表上验过（24 门 / 14 门）。不同学校的版式差异大，
   解析器是"尽力而为 + 预览确认"的设计，不会静默写错。
3. **图片 OCR 的识别效果**已在真机 Pura 70 验过（§5.3：真实作息表截图 12 节全中）；
   **没验的是"PDF 页面渲染出的图 → OCR"这一步**的识别质量 —— 模拟器没有 OCR 后端
   （1001400001），链路与解析器都验到 OCR 调用为止（§6.15）。
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

## 9. UI 规范守卫脚本

`node tools/check-ui.mjs`（= `npm run check:ui`；`npm run check` = 架构守卫 + UI 守卫）。
它只干一件事：把应用市场自检里那条**硬指标**变成本地能跑的红线 ——

1. 扫 `entry/src/main/ets/**/*.ets` 里所有字号字面量：`.fontSize(7)`、`.fontSize('7fp')`、
   `.font({ size: 7 })`；
2. 小于 8fp → 打 `::error::` 并退出 1（对应自检"最小不得小于 8 fp（必须）"）；
3. 8~11fp → 只列提示、不失败（自检对"推荐 12fp"不判失败；而周视图格子物理上只有 22~46vp 宽，
   12fp 会把中文挤成一列竖字）。

为什么不写成测试：这是**扫源码**的规则，对象是全部 `.ets`（含不在 Node 测试范围内的 UI 层）。
两者分工不重叠 —— `check-ui.mjs` 管"字面量随手写死"，`tests/cell-layout.test.ts` 管
"常量与算式"（把字号常量当契约钉住，并遍历高度/宽度/缩放组合断言 ≥8fp）。

脚本自己也验证过：临时放一个 `Text('x').fontSize(7)` 的探针文件进去，
输出 `::error::view/__probe.ets:2 fontSize = 7fp，小于上架自检的硬下限 8fp` 且退出码 1；
删掉探针后回到 `UI 规范守卫通过：扫描 7 个 .ets，无小于 8fp 的字号`。
