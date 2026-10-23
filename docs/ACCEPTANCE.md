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
| debug · WebView 改成**用时才创建** | 878 / 585 / 642 | **642** |
| release（AOT，`-p buildMode=release`）· 懒加载 | 598 / 692 / 644 | **644** |

结论：
1. **首帧挂 1.5MB 的 pdf.js 会白白多花约 0.6s**（ArkWeb 引擎在进程启动阶段就要初始化：
   日志里 `C04500/webview: CalculateActiveWebEngineVersion` 出现在 `LoadModule` 之前）。
   已改成「点导入/跑 spike 时才创建 Web 组件」。
2. release 与 debug 差别不大 → **瓶颈不在 ArkTS 代码**，而在 ArkUI 引擎与模拟器的软件渲染。
   首帧不做任何数据库操作（`EntryAbility.onCreate` 为空，`aboutToAppear` 只是发起异步加载，
   首帧画的是空网格 + 加载指示）。
3. 与 Android 版（178 ms）比，这台模拟器上约慢 3.5 倍。**真机预期明显更快**，
   但这一条目前**没有真机数据**，不作承诺。

## 2. 体积

| 项 | 大小 |
|---|---|
| HAP（release，未签名） | **2.21 MB** |
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
| Node 断言 | **199 条 / 13 套**（`node --test "tests/*.test.ts"`，不需要鸿蒙 SDK） |
| 架构守卫 | `logic/`、`data/` 零平台依赖；内部 import 必须带 `.ts`（CI 里两条 grep 守卫） |
| ArkTS 构建 | `BUILD SUCCESSFUL`（debug 与 release 都验过） |
| CI | GitHub Actions：每次 push 跑全部断言 + 两条架构守卫 |

## 5. 功能覆盖（相对 Android 版）

| 功能 | 状态 |
|---|---|
| 周视图（7 列 × N 节、今天高亮、并排冲突、翻周、回到本周、详情卡） | ✅ |
| 「打开即当前周」两条抑制规则 | ✅ 12 断言（含 8 个时序复演） |
| 多课表（列表/切换/新建/重命名/主课表/删除/启动开关） | ✅ |
| 作息编辑（改时间/加一节/删一节自动重编号/恢复默认） | ✅ |
| PDF 导入（选文件 → 预览 → 覆盖/合并/新建课表） | ✅ 真实课表认得 24 门 |
| 自定义安排（读写已就绪，**界面未做**） | 🔶 数据层可用 |
| 新建/编辑课程 | 🔶 点空白格只弹提示 |
| 截图 OCR 导入 | ⬜ 模拟器无 OCR 后端，需真机 |
| 学期设置（改开学日/周数） | 🔶 数据层 + 导入时沿用，**没有独立入口** |

## 6. 遗留风险

1. **冷启动只在模拟器上量过**，真机未测（模拟器是软件渲染，数字偏悲观）。
2. **PDF 导入的解析正确率**只在 1 份真实课表上验过（24 门）。不同学校的版式差异大，
   解析器是"尽力而为 + 预览确认"的设计，不会静默写错。
3. **OCR 通道完全没有端到端验证**（模拟器无后端）。代码可以写，但不写就少一块功能 —— 待真机。
4. 冲突格的并排显示在窄列下文字会竖排（与 Android 版一致的既有行为）。
