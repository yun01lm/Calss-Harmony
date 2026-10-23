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

## 4. 外键级联：鸿蒙上**关着**，所以一律显式删

| | Android 版 | 鸿蒙版 |
|---|---|---|
| 删课表/删课 | 靠 `ON DELETE CASCADE` 连带清 `course_schedules` | **显式 `DELETE FROM course_schedules WHERE ...`** |
| 依据 | Room 打开库时会 `PRAGMA foreign_keys = ON` | 设备实测 `PRAGMA foreign_keys = 0`（`docs/evidence/14-probe-fk.jpeg` 第一行）。关系型库默认就是 OFF |
| 后果 | —— | 若照抄 Android 的写法，删课表后会留下一堆孤儿时段；新建课程一旦复用到同一个 id，就会"借尸还魂"出现在别的课表里 |
| 断言 | —— | `tests/store.test.ts` 的删除用例**故意不开外键**（`SqliteRunner.open({ foreignKeys: false })`），证明清得干净 |

## 5. 周次掩码：JS number 只有 53 位安全整数

| | Android 版 | 鸿蒙版 |
|---|---|---|
| 存储 | SQLite INTEGER（64 位）+ Kotlin `Long`，理论上 64 周 | 同一列、同一类型，但 `getLong()` 返回 **JS number**，超过 2^53 会丢精度 |
| 本应用实际范围 | 周数夹在 1..30 | 同左（`clampTotalWeeks`），远在安全范围内 |
| 兜底 | —— | `maskToDb` / `assertSafeMask`：越界**直接抛错**，而不是安静存进一个错的周次（`tests/store.test.ts` 有断言） |

## 6. 与平台相关、不算差异的部分（说明以便对照）

| 主题 | Android | 鸿蒙 |
|---|---|---|
| 长度/字号单位 | `dp` / `sp` | `vp` / `fp`（算法逻辑一致，见 `logic/CellLayout.ts`） |
| 周次掩码类型 | `Long`（64 位） | `bigint`（语义等价；交界处 `BigInt()`/`Number()` 转换） |
| 日期运算 | `java.time.LocalDate` | **epochDay 整数**（不直接用 `Date`，规避时区/夏令时） |
| 程序化翻页 | `PagerState.animateScrollToPage` | `SwiperController.changeIndex`（两者都会触发回调，抑制规则一致） |
| 数据库存储位置 | `context.getDatabasePath("calss.db")` | relationalStore 沙箱（`databaseDir/rdb/`），库名同为 `calss.db` |
| 库版本号 | Room `version = 2` | SQLite `user_version = 2`（同一个字段，含义一致） |

## 7. 课程编辑：保存按钮在顶栏，软键盘盖不住

| | Android 版 | 鸿蒙版 |
|---|---|---|
| 面板布局 | `AlertDialog` 底部按钮（`confirmButton`），系统负责把对话框抬到键盘上方 | 自绘底部面板：**「取消 / 保存」放顶栏**，主按钮不再放面板底部 |
| 理由 | —— | 自绘面板高度固定（76%），软键盘弹出时不会自动上推，底部的按钮直接被盖住。实测模拟器上输完课程名后点不到「保存」（`docs/evidence/32-course-editor.jpeg`） |

## 8. 三处"顺手补齐"的交互（Android 版没有，本版新增）

| 行为 | 为什么加 |
|---|---|
| 保存课程后，若**当前这一周没有这门课**，自动跳到它第一次出现的那一周 | 把周次改成 `5-6` 而人停在第 1 周时，保存后界面毫无变化，看起来像"没保存上"（实测就是这样）。跳一下比弹个提示更直接 |
| 翻周（箭头或滑动）时**自动收起详情卡** | 卡片描述的是上一周的某门课，留着会让人以为这门课在这一周 |
| 课程编辑面板的**删除要按两次**（第一次变红、文案改成"再按一次删除这门课"） | 删除不可撤销；两次点击比一个系统确认框更省事，也避免手滑 |

> 新增差异时请在此追加一节，并在对应测试里留下断言。
