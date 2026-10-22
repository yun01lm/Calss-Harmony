# 架构

## 三层 + 一条硬边界

```
┌───────────────────────────────────────────────┐
│ pages/ + view/       ArkUI 页面与组件          │  只做渲染与交互，状态由 store 提供
├───────────────────────────────────────────────┤
│ platform/           系统能力适配器             │  relationalStore / picker / PDF Kit / Core Vision
├───────────────────────────────────────────────┤
│ logic/              纯逻辑（零平台依赖）        │  可在 Node 上直接跑测试
└───────────────────────────────────────────────┘
```

### 硬边界（最重要的一条约定）

`entry/src/main/ets/logic/**` **禁止** import 任何 `@kit.*`、`@ohos.*`，也不允许引用 ArkUI 组件。

原因：鸿蒙 SDK 只装在开发机上，而逻辑正确性应该**在任何有 Node 的地方**都能验证（包括 CI）。
两侧分工：

- `logic/**`：数据形状、周次位运算、日期推算、输入规范化、教室短形式、冲突判定、格子行数算法、
  课表文本解析、作息文本解析
- `platform/**`：把系统 API 的结果转成 `logic/**` 需要的纯数据（如把 `ResultSet` 转成对象数组、
  把 PDF 文本流转成 `TextLine[]`），以及把 `logic/**` 的产物写回系统

## 逻辑层的四条编码约定（都是编译实测踩出来的，别改）

逻辑层只有**一份 `.ts` 源码**：Node 直接跑测试、hvigor 直接编进 HAP。
要实现这点，下面四条是硬约束：

| # | 约定 | 违反时的症状 |
|---|------|-------------|
| 1 | **每个模块导出一个静态类**（照搬 Kotlin 的 `object`：`WeekMasks.parse(...)`、`Minutes.format(...)`），**不要散装导出同名函数** | ArkTS 报 `Module './Minutes' has already exported a member named 'format'`（`parse`/`format` 撞名是必踩的） |
| 2 | **`logic/**` 内部 import 必须带 `.ts` 扩展名**（`import { Minutes } from './Minutes.ts'`） | Node ESM 报 `ERR_MODULE_NOT_FOUND`（Node 强制要扩展名）；ArkTS 两种都接受，所以统一带扩展名 |
| 3 | **对象字面量必须有显式类型**（返回处标 `: CellLines`、局部标 `const out: CellLines = {...}`） | ArkTS 报 `Object literal must correspond to some explicitly declared class or interface` |
| 4 | **不用泛型约束**（`<T extends GridSlot>` 这类），直接用具体 interface | ArkTS 对约束泛型的支持有限，容易报不可推断的字面量类型 |

补充：
- 数值精度：周次掩码用 **`bigint`**（对应 Kotlin `Long`），不要用 `number` 的位运算（只有 32 位）；
  与数据库交界处显式转换 `BigInt(row.weekMask)` / `Number(mask)`。
- 日期：全部用 **epochDay 整数**（`WeekCalculator`），不要把 `Date` 传进业务逻辑 —— 时区/夏令时会差一天。
- 测试跑法：`npm test`（= `node --test "tests/*.test.ts"`），**不需要鸿蒙 SDK**。
- 每个模块加进 `logic/index.ts` 桶文件，并在页面里被真实调用 —— 否则 hvigor 可能把没被引用的模块当死代码不编译。

## 目录规划

```
entry/src/main/ets/
├── entryability/EntryAbility.ets   入口（启动路径零初始化）
├── pages/Index.ets                 主页（周视图）
├── view/                           网格、周次条、对话框
├── platform/                       Rdb / Picker / Pdf / Ocr 适配器
├── data/                           schema、migrations、ScheduleStore
├── logic/                          ★ 纯逻辑（对应 Android 的 model/ 与解析层）
└── common/                         主题、常量、小工具
```

## 启动策略

与 Android 版一致：

- `EntryAbility.onCreate` / `onWindowStageCreate` 不做初始化
- 数据库、解析器、OCR 全部**用时才加载**
- 首帧不等数据：页面自带默认状态（例如「第 1 周」占位），数据到达后更新

## 状态管理

ArkTS 没有 ViewModel/Flow 的等价物，采用：

- 单例 `ScheduleStore`（`@Observed`）持有"当前课表 + 快照"
- 页面用 `@State` 持有自己的界面状态，订阅 store 变化
- 所有写操作走 store 的方法（单一入口，便于测试）

### 关于「打开即当前周」

Android 版踩过的坑必须原样避开：**程序化翻页（`SwiperController.changeIndex`）会触发 `onChange`**，
不能把"程序化翻页"当成"用户选择了某一周"。两条规则：

1. 程序化翻页**整段期间**不上报（不是只忽略最终页）
2. 仅当目标周与"当前显示的周"**不同**时才上报

详见 `logic/WeekSelection.ts`（阶段 0B 落地）与 `tests/week-selection.test.mjs`。