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
`entry/src/main/ets/data/**` 同样禁止（CI 里有守卫）。

原因：鸿蒙 SDK 只装在开发机上，而逻辑正确性应该**在任何有 Node 的地方**都能验证（包括 CI）。
两侧分工：

- `logic/**`：数据形状、周次位运算、日期推算、输入规范化、教室短形式、冲突判定、格子行数算法、
  课表文本解析、作息文本解析
- `data/**`：schema / 迁移 / 建库决策 / 业务语义（`ScheduleStore`）/ 模型
- `platform/**`：把系统 API 的结果转成 `logic/**`、`data/**` 需要的纯数据
  （如把 `ResultSet` 转成对象数组、把 PDF 文本流转成 `TextLine[]`），以及把产物写回系统

### SqlRunner：让业务语义也能在 Node 上测

`data/ScheduleStore.ts` 不直接依赖 `platform/Rdb.ts`，而是依赖 5 个方法的接口 `data/SqlRunner.ts`：

```
data/ScheduleStore.ts   业务语义（启动选表 / 覆盖与合并导入 / 删表连带清理）
        │ 依赖
        ▼
data/SqlRunner.ts       只有 query / exec / runSteps / scalarInt / insertAndGetId
        │
   ┌────┴─────────────────────────┐
   ▼                              ▼
platform/Rdb.ts            tests/helpers/sqliteRunner.ts
（relationalStore，真机）    （node:sqlite，CI）
```

好处是**同一份 store 代码**在设备上跑真库、在 CI 上跑内存库；坏处是接口必须只有 5 个方法 ——
能力越大，两个实现越容易行为不一致，测试也就越假。加方法前先想想：能不能用现有 5 个拼出来。


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

ArkTS 没有 ViewModel/Flow 的等价物。实际做法（比"单例持有全部状态"更简单，也更好测）：

- `data/ScheduleStore.ts` 是**纯数据层**：无 ArkUI 依赖、无单例、无订阅。构造时传入 `SqlRunner`，
  方法都是 `async`，想读就 `await store.snapshot()`。
- 页面（`pages/Index.ets`）用 `@State` 持有"快照 + 视图状态"，一次读完再渲染；
  写完（导入、编辑）重新 `load()` 一次。**没有可观察数据流** —— 数据量是几百行，重读一次是毫秒级，
  换来的是"状态只有一处、不需要猜谁改了谁"。
- 所有写操作都走 store 的方法（单一入口，Node 上可测）。

### UI 层四条约定（都是编译/实机踩出来的）

| # | 约定 | 违反时的症状 |
|---|------|-------------|
| 1 | 子组件的**数据参数必须 `@Prop`**（`@Prop items: WeekItem[]`），普通成员只在创建时赋值一次 | 父组件更新了数据，子组件仍显示旧内容。周视图第一版就是这样：首帧数据库空着 → 网格拿到空数组 → 数据到了网格还空着，而标题栏已显示"本周"（那是父组件的状态） |
| 2 | 回调参数（`onItemTap` 这类）用普通成员即可，不需要 `@Prop` | —— |
| 3 | 界面里"算出来的数"（格子高度、行数、颜色）**必须来自 `logic/`**，不许在 `.ets` 里重写一份算式 | 两边算法漂移后，测试全绿但界面是错的 |
| 4 | 组件内的布局尺寸用 `onAreaChange` 拿到的 vp 值算，不要写死像素 | 换机型/折叠屏比例就错 |
| 5 | 底部面板里的**主按钮放顶栏**，别放在面板最底下 | 软键盘弹出会盖住面板底部。实测：课程编辑面板的「保存」正好躲在键盘下面，输完课程名反而点不到（`view/CourseEditor.ets` 改成顶栏「取消 / 保存」） |

### 关于「打开即当前周」

Android 版踩过的坑必须原样避开：**程序化翻页（`SwiperController.changeIndex` / `Swiper.index`）会触发 `onChange`**，
不能把"程序化翻页"当成"用户选择了某一周"。两条规则：

1. 程序化翻页**整段期间**不上报（不是只忽略最终页）
2. 仅当目标周与"当前显示的周"**不同**时才上报

✅ 已落地：`logic/WeekSelection.ts`（`shouldReport` + `ANIMATION_GUARD_MS`）与 `tests/week-selection.test.ts`
（含 8 个**时序复演**用例：首帧、跨多页跳转、跳走后用户再滑、回到本周后再滑回同一页、学期末边界）。