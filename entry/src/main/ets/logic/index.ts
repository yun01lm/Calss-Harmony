/**
 * 逻辑层桶文件（barrel）。
 *
 * 作用：
 * 1. 给 UI 层一个统一入口（`import { ... } from '../logic'`），模块增删不影响调用方；
 * 2. **构建守卫**：页面从这里 import，hvigor 就会编译下面列出的全部模块 ——
 *    避免"某个模块没被引用、坏了也没人发现"。
 *
 * 注意：各模块对外只导出一个**静态类**（照搬 Kotlin 的 `object` 结构），
 * 因此 `export *` 不会出现同名成员冲突（ArkTS 会报 `has already exported a member`）。
 *
 * 约定：`logic/**` 内**禁止** import 任何 `@kit.*` / `@ohos.*` / 页面组件，
 * 保证这些模块都能在 Node 上直接跑测试（见 tests/）。
 */
export * from './CellLayout.ts';
export * from './Colors.ts';
export * from './Conflicts.ts';
export * from './CourseDraft.ts';
export * from './EventDraft.ts';
export * from './GridFormatParser.ts';
export * from './InputNorm.ts';
export * from './ListFormatParser.ts';
export * from './Locations.ts';
export * from './Minutes.ts';
export * from './ParsingUtils.ts';
export * from './PdfModels.ts';
export * from './PdfRunText.ts';
export * from './TimetableTextParser.ts';
export * from './WeekCalculator.ts';
export * from './WeekItems.ts';
export * from './WeekMasks.ts';
export * from './WeekSelection.ts';
