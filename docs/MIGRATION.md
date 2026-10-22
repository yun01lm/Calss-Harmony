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
| `data/ScheduleRepository.kt` | `data/ScheduleStore.ts`（依赖 `data/SqlRunner.ts` 接口） | ✅ 26 断言（真 SQLite：启动选表/建表/删除清理/覆盖与合并导入/快照） |
| `data/db/*`（Room、迁移 v1→v2） | `data/schema.ts` + `data/migrations.ts` + `data/bootstrap.ts` | ✅ 33 断言（真 SQLite：建库/迁移/级联/导入三态/启动选表/幂等/五种版本状态） |
| `AppDatabase.get()` 懒加载单例 | `platform/Rdb.ts` | ✅ 实机验证（见下方「设备侧验证」） |
| `HomeViewModel.itemsByWeek` / `periodCount` | `logic/WeekItems.ts` | ✅ 12 断言（周次命中/脏数据/冲突/安排/行数） |
| `HomeViewModel.colorFor` + `PALETTE` | `logic/Colors.ts` | ✅ 3 断言（含 Kotlin `hashCode` 逐值对齐） |
| `HomeScreen` 的「打开即当前周」抑制规则 | `logic/WeekSelection.ts` | ✅ 12 断言（8 个时序复演） |
| `ui/home/WeekGrid.kt` | `view/WeekGrid.ets` | ✅ 实机（见下方存证 15–20） |
| `ui/home/HomeScreen.kt` | `pages/Index.ets` | 🔄 周视图 + 翻周 + 详情卡完成；新建/编辑课程待阶段 3 |
| `ui/home/ItemDetailDialog.kt` | `pages/Index.ets` 底部详情卡 | 🔄 只读展示完成，编辑待阶段 3 |
| `ui/pdfimport/*` | `view/import/*` + `platform/Pdf.ts` | ⬜ |
| `ui/timetableimport/*` | `view/timetableimport/*` + `platform/Ocr.ts` | ⬜ |
| `ui/timetable/*`（多课表） | `view/timetable/*` | ⬜ |
| SAF（`OpenDocument`） | `@ohos.file.picker` | ⬜ |
| Room | `relationalStore` | ✅ 已验证（事务执行 DDL/DML、`user_version` 读写、`sqlite_master` 查询） |
| pdfbox-android | PDF Kit `getTextContent()` / ArkWeb + pdf.js | ⬜ 待 spike |
| ML Kit 中文 OCR | Core Vision Kit `textRecognition` | ⬜ 待 spike |
| `tools/verify_*.{py,ps1}`（7 套） | `tests/*.test.ts`（Node 内置 test） | 🔄 12 套 / 188 断言已移植 |

## 设备侧验证（模拟器，HarmonyOS 7.0 / API 26）

`platform/MigrationProbe.ts` 是**临时验收工具**，现在藏在**开发者入口**里（标题连点 5 次），
不占界面、也不会成为死代码（它被页面引用，每次构建都会编译）。设备沙箱不可读写，
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

`platform/Rdb.ts` 接上 `ScheduleStore` 之后又走了一遍（`docs/evidence/10..13-*.jpeg`）：
写入 → 「1 门课 · 1 个时段 · 首门课：持久化测试（周3 5-6 节 · 1-16）」→ 重启（pid 6664 → 6913）仍在 → 清空回 0。
这一轮顺带验到了两个 Node 测不出的原语：`createTransaction` 里执行 INSERT、以及
`SELECT last_insert_rowid()` 与 INSERT 同事务（`insertAndGetId`）。

### 实测：`PRAGMA foreign_keys = 0`

演练页第一行是设备的真实取值 —— **外键是关的**。Android 版依赖 `ON DELETE CASCADE` 清时段，
在鸿蒙上那样做会留下孤儿 `course_schedules`。所以 `ScheduleStore` 一律**显式删**时段，
并用「外键关着」的测试夹具证明不留孤儿（`tests/store.test.ts` 的 delete 用例）。

## 周视图（阶段 2）实机验证

存证 `docs/evidence/15..20-*.jpeg`：

| 场景 | 结果 |
|---|---|
| 空课表 | 网格 7 列 × 12 节、今天那一列高亮（周四 10/22）、表头显示本周日期 |
| 写入 4 门示例课 | 色块按周次出现；周一 3-4 节两门课**并排双道 + ⚠**（冲突） |
| 单周课（1-15 单） | 第 1、3 周出现，第 2 周消失 |
| 点「›」/ 滑动 | 第 2 周（无单周课）→ 第 3 周（单周课回来），表头日期随之改变 |
| 点「回到本周」 | 回第 1 周，日期后标注「· 本周」，「回到本周」按钮消失（换回「本周」提示） |
| 点色块 | 底部详情卡：周几/第几节/教师/教室/周次（`WeekMasks.format` 的结果） |

> 示例课与清空按钮也在开发者入口里（4 门课故意让两门撞在同一格，否则"并排双道"永远没有数据能验到）。


## 已知的平台差异（实现时注意）

| 主题 | Android | 鸿蒙 |
|---|---|---|
| 长度单位 | `dp` / `sp` | `vp` / `fp`（字体缩放走 `fp`） |
| 程序化翻页 | `PagerState.animateScrollToPage` + 自己抑制回调 | `SwiperController.changeIndex` + `onChange`，同样需要抑制 |
| 数据库 API | Room（注解 + 编译期校验 SQL） | `relationalStore`（手写 SQL，运行期才报错 → 必须靠 Node 断言兜） |
| 打开库时的 schema 校验 | Room 自动逐列比对，不匹配直接抛 | **没有等价物** → 用 `data/bootstrap.ts` 的五种状态判断 + 迁移演练页补上（见 COMPAT） |
| 日期 | `java.time.LocalDate` | `Date`（注意时区/月初月末边界） |
| 文件选择 | SAF | `DocumentViewPicker` |