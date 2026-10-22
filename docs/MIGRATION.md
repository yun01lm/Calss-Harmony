# 与 Android 版的模块对照

行为规格以 [Calss-Android](https://github.com/yun01lm/Calss-Android) 为准；任何差异记录到 `docs/COMPAT.md`。

| Android（Kotlin） | 鸿蒙（ArkTS） | 状态 |
|---|---|---|
| `model/WeekMasks.kt` | `logic/WeekMasks.ts` | ✅ 16 断言 |
| `model/WeekCalculator.kt` | `logic/WeekCalculator.ts` | ✅ 12 断言 |
| `model/InputNorm.kt` | `logic/InputNorm.ts` | ✅ 11 断言 |
| `ui/common/Locations.kt` | `logic/Locations.ts` | ✅ 6 断言 |
| `HomeViewModel.markConflicts` + `WeekGrid.lanesFor` | `logic/Conflicts.ts` | ✅ 9 断言 |
| `WeekGrid` 行数算式 | `logic/CellLayout.ts` | ✅ 8 断言 |
| `ocr/TimetableTextParser.kt` | `logic/TimetableTextParser.ts` | ✅ 18 断言（真实样本 21 行） |
| `pdf/GridFormatParser.kt` / `ListFormatParser.kt` | `logic/GridFormatParser.ts` / `logic/ListFormatParser.ts` | ✅ 24 断言（合成夹具） |
| `data/ScheduleRepository.kt` | `data/ScheduleStore.ts` | 🔄 下一步（`platform/Rdb.ts` 已就位） |
| `data/db/*`（Room、迁移 v1→v2） | `data/schema.ts` + `data/migrations.ts` + `data/bootstrap.ts` | ✅ 33 断言（真 SQLite：建库/迁移/级联/导入三态/启动选表/幂等/五种版本状态） |
| `AppDatabase.get()` 懒加载单例 | `platform/Rdb.ts` | ✅ 实机验证（见下方「设备侧验证」） |
| `ui/home/WeekGrid.kt` | `view/WeekGrid.ets` | ⬜ |
| `ui/home/HomeScreen.kt` | `pages/Index.ets` | ⬜ |
| `ui/pdfimport/*` | `view/import/*` + `platform/Pdf.ts` | ⬜ |
| `ui/timetableimport/*` | `view/timetableimport/*` + `platform/Ocr.ts` | ⬜ |
| `ui/timetable/*`（多课表） | `view/timetable/*` | ⬜ |
| SAF（`OpenDocument`） | `@ohos.file.picker` | ⬜ |
| Room | `relationalStore` | ✅ 已验证（事务执行 DDL/DML、`user_version` 读写、`sqlite_master` 查询） |
| pdfbox-android | PDF Kit `getTextContent()` / ArkWeb + pdf.js | ⬜ 待 spike |
| ML Kit 中文 OCR | Core Vision Kit `textRecognition` | ⬜ 待 spike |
| `tools/verify_*.{py,ps1}`（7 套） | `tests/*.test.ts`（Node 内置 test） | 🔄 9 套 / 135 断言已移植 |

## 设备侧验证（模拟器，HarmonyOS 7.0 / API 26）

`platform/MigrationProbe.ts` 是**临时验收工具**（阶段 2 做周视图时删除）。设备沙箱不可读写，
没法像桌面那样塞一个 v1 库进去，所以在设备上造一个独立的 `calss_probe.db`，走**和正式库同一份**
`Rdb.ensureUpToDate()`，18 条断言全绿：

| # | 断言 | 结果 |
|---|---|---|
| 1-3 | 造 v1 库 → 识别为 `upgrade` → 版本号升到 2 | ✓ |
| 4 | 旧 `semesters` 表已删除 | ✓ |
| 5 | 旧学期（名字/开学日/18 周/主课表）搬进第 1 张课表 | ✓ |
| 6-7 | 旧课程与旧作息回填 `timetableId = 1` | ✓ |
| 8-9 | 时段未被动过；偏好 `current_timetable = 1` | ✓ |
| 10 | 3 个 `index_*_timetableId` 已建 | ✓ |
| 11-12 | 再开一次是 `noop`（迁移只跑一次）；关库重开数据仍在 | ✓ |
| 13-16 | 空库 → `fresh` → 版本 0→2 → 12 节作息 → 第 1 张课表 | ✓ |
| 17-18 | 重开是 `noop`；作息仍是 12 节（不重复播种） | ✓ |

另外用正式库 `calss.db` 验证了**真持久化**：写入 1 门测试课 → `aa force-stop`（pid 从 30378 变 31405）
→ 重启后仍显示「1 门课」且 `noop`（不重建）；再点清空 → 变回「0 门课」。
存证：`docs/evidence/04..09-*.jpeg`。


## 已知的平台差异（实现时注意）

| 主题 | Android | 鸿蒙 |
|---|---|---|
| 长度单位 | `dp` / `sp` | `vp` / `fp`（字体缩放走 `fp`） |
| 程序化翻页 | `PagerState.animateScrollToPage` + 自己抑制回调 | `SwiperController.changeIndex` + `onChange`，同样需要抑制 |
| 数据库 API | Room（注解 + 编译期校验 SQL） | `relationalStore`（手写 SQL，运行期才报错 → 必须靠 Node 断言兜） |
| 打开库时的 schema 校验 | Room 自动逐列比对，不匹配直接抛 | **没有等价物** → 用 `data/bootstrap.ts` 的五种状态判断 + 迁移演练页补上（见 COMPAT） |
| 日期 | `java.time.LocalDate` | `Date`（注意时区/月初月末边界） |
| 文件选择 | SAF | `DocumentViewPicker` |