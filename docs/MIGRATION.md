# 与 Android 版的模块对照

行为规格以 [Calss-Android](https://github.com/yun01lm/Calss-Android) 为准；任何差异记录到 `docs/COMPAT.md`。

| Android（Kotlin） | 鸿蒙（ArkTS） | 状态 |
|---|---|---|
| `model/WeekMasks.kt` | `logic/WeekMasks.ts` | ⬜ 待移植 |
| `model/WeekCalculator.kt` | `logic/WeekCalculator.ts` | ⬜ |
| `model/InputNorm.kt` | `logic/InputNorm.ts` | ⬜ |
| `ui/common/Locations.kt` | `logic/Locations.ts` | ⬜ |
| `HomeViewModel.markConflicts` + `WeekGrid.lanesFor` | `logic/Conflicts.ts` | ⬜ |
| `WeekGrid` 行数算式 | `logic/CellLayout.ts` | ⬜ |
| `ocr/TimetableTextParser.kt` | `logic/TimetableTextParser.ts` | ⬜ |
| `pdf/GridFormatParser.kt` / `ListFormatParser.kt` | `logic/GridRows.ts` / `logic/ListRows.ts` | ⬜ |
| `data/ScheduleRepository.kt` | `data/ScheduleStore.ts` + `platform/Rdb.ts` | ⬜ |
| `data/db/*`（Room、迁移 v1→v2） | `data/schema.ts` + `data/migrations.ts` | ⬜ |
| `ui/home/WeekGrid.kt` | `view/WeekGrid.ets` | ⬜ |
| `ui/home/HomeScreen.kt` | `pages/Index.ets` | ⬜ |
| `ui/pdfimport/*` | `view/import/*` + `platform/Pdf.ts` | ⬜ |
| `ui/timetableimport/*` | `view/timetableimport/*` + `platform/Ocr.ts` | ⬜ |
| `ui/timetable/*`（多课表） | `view/timetable/*` | ⬜ |
| SAF（`OpenDocument`） | `@ohos.file.picker` | ⬜ |
| Room | `relationalStore` | ⬜ |
| pdfbox-android | PDF Kit `getTextContent()` / ArkWeb + pdf.js | ⬜ 待 spike |
| ML Kit 中文 OCR | Core Vision Kit `textRecognition` | ⬜ 待 spike |
| `tools/verify_*.{py,ps1}`（7 套） | `tests/*.test.mjs`（Node 内置 test） | ⬜ |

## 已知的平台差异（实现时注意）

| 主题 | Android | 鸿蒙 |
|---|---|---|
| 长度单位 | `dp` / `sp` | `vp` / `fp`（字体缩放走 `fp`） |
| 程序化翻页 | `PagerState.animateScrollToPage` + 自己抑制回调 | `SwiperController.changeIndex` + `onChange`，同样需要抑制 |
| 数据库 API | Room（注解 + 编译期校验 SQL） | `relationalStore`（手写 SQL，运行期才报错 → 必须靠 Node 断言兜） |
| 日期 | `java.time.LocalDate` | `Date`（注意时区/月初月末边界） |
| 文件选择 | SAF | `DocumentViewPicker` |