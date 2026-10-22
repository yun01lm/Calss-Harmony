# 与 Android 版的行为差异

行为规格以 [Calss-Android](https://github.com/yun01lm/Calss-Android) 为准。
**只有在本文件里登记过的差异，才算"有意为之"**；没登记的不一致都按 bug 处理。

---

## 1. 作息解析：全部认不出时，把具体原因也报出来

| | Android 版 | 鸿蒙版 |
|---|---|---|
| 场景 | 一张作息表截图，里面**所有**时间都非法（或全是课间行） | 同左 |
| 行为 | 只返回一句"没能从图片里认出作息时间，可以在下面手动添加节次"，而"有 N 处时间不合法""有 N 行是课间"这些**已统计到的原因被丢弃** | 先列出已统计到的原因（重复 / 时间不合法 / 课间行数），再给出上面那句兜底提示 |
| 位置 | `ocr/TimetableTextParser.kt` 的 `if (found.isEmpty())` 分支 | `logic/TimetableTextParser.ts` 同名分支 |
| 理由 | —— | 用户看到"认不出"时最需要知道的是**为什么**（是截图截错了，还是时间格式怪？）。丢原因等于让人无从下手。断言见 `tests/timetable-text-parser.test.ts` → "非法时间（开始晚于结束）被忽略并提示" |

## 2. 数据库打开：没有 Room 的 schema 校验，改用"状态判断 + 演练"

| | Android 版 | 鸿蒙版 |
|---|---|---|
| 机制 | Room 在打开库时把实体推导出的 schema 与实际表逐列比对，不一致直接抛 `IllegalStateException` | `relationalStore` 没有等价校验，SQL 写错只有运行时才知道 |
| 补法 | —— | ① 建库/迁移全部是**一份可在 Node 上跑的真 SQL 步骤清单**（`tests/bootstrap.test.ts`、`tests/sql.test.ts`，共 33 条断言）；② 打开库时按「版本号 × 现有表」分成 fresh / upgrade / repair / noop 四态，遇到矛盾（版本 0 但只有一半的表、版本高于支持）**直接报错拒绝打开**，不猜、不删；③ 写入版本号后**回读校验**；④ 设备上用 `platform/MigrationProbe.ts` 造 v1 库跑一遍真机迁移 |

## 3. 建库/迁移失败时的表现

| | Android 版 | 鸿蒙版 |
|---|---|---|
| 迁移中途失败 | Room 事务回滚，进程崩溃（用户看到闪退） | 事务回滚 + 抛出带原因的错误，页面显示「数据库失败：…」而不是闪退 |
| 理由 | —— | 课表打不开时，一句能读的错因比闪退有用；且迁移是幂等的（播种步骤带 `WHERE NOT EXISTS`），修好后再启动会重试 |

## 4. 与平台相关、不算差异的部分（说明以便对照）

| 主题 | Android | 鸿蒙 |
|---|---|---|
| 长度/字号单位 | `dp` / `sp` | `vp` / `fp`（算法逻辑一致，见 `logic/CellLayout.ts`） |
| 周次掩码类型 | `Long`（64 位） | `bigint`（语义等价；交界处 `BigInt()`/`Number()` 转换） |
| 日期运算 | `java.time.LocalDate` | **epochDay 整数**（不直接用 `Date`，规避时区/夏令时） |
| 程序化翻页 | `PagerState.animateScrollToPage` | `SwiperController.changeIndex`（两者都会触发回调，抑制规则一致） |
| 数据库存储位置 | `context.getDatabasePath("calss.db")` | relationalStore 沙箱（`databaseDir/rdb/`），库名同为 `calss.db` |
| 库版本号 | Room `version = 2` | SQLite `user_version = 2`（同一个字段，含义一致） |

> 新增差异时请在此追加一节，并在对应测试里留下断言。
