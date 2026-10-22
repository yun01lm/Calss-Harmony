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

## 2. 与平台相关、不算差异的部分（说明以便对照）

| 主题 | Android | 鸿蒙 |
|---|---|---|
| 长度/字号单位 | `dp` / `sp` | `vp` / `fp`（算法逻辑一致，见 `logic/CellLayout.ts`） |
| 周次掩码类型 | `Long`（64 位） | `bigint`（语义等价；交界处 `BigInt()`/`Number()` 转换） |
| 日期运算 | `java.time.LocalDate` | **epochDay 整数**（不直接用 `Date`，规避时区/夏令时） |
| 程序化翻页 | `PagerState.animateScrollToPage` | `SwiperController.changeIndex`（两者都会触发回调，抑制规则一致） |

> 新增差异时请在此追加一节，并在对应测试里留下断言。
