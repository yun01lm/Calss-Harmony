/**
 * 「打开即当前周」的两条抑制规则（纯逻辑，Android 侧踩过坑后的结论）。
 *
 * 背景：`Swiper` 的 `onChange` **区分不了**"用户滑的"和"代码翻的"。
 * 如果照着回调就把页码记成"用户选了第 N 周"，会出两个真机 bug：
 *
 * 1. **首帧**：数据还没读出来时 Swiper 停在第 1 页，回调一来就把"跟随当前日期"永久关掉
 *    → 无论真实第几周，每次打开都停在第 1 周；
 * 2. **程序化翻页**（箭头 / 回到本周 / 首帧对齐）会**依次经过中间页**，
 *    只看最终页不够 → 实测停在"第 3 周"。
 *
 * 所以规则是两条，缺一不可：
 *
 * | # | 规则 | 违反时的症状 |
 * |---|------|-------------|
 * | 1 | 程序化翻页**整段期间**都不上报（不是只忽略最终页） | 用箭头从第 1 周跳到第 10 周，中途把"selectedWeek"写成第 3 周 |
 * | 2 | 仅当目标页与**当前显示的周**不同才上报（瞬时判据，不能用长期记住的页码） | 曾经用 autoPage 记住"程序翻过的那页"，用户滑回那页时被永久忽略 → 标题第 6 周、网格第 5 周 |
 */
export class WeekSelection {
  /**
   * 程序化翻页的抑制时长（毫秒）。
   * `SwiperController.changeIndex` 不是可 await 的，没有"滚动结束"回调，
   * 所以用稍大于动画时长的一段时间把回调压住；规则 2 会兜住超时后的残留上报。
   */
  static readonly ANIMATION_GUARD_MS: number = 400;

  /** 周次夹到 1..totalWeeks（totalWeeks 为 0 时按 1 处理，避免 min > max） */
  static clamp(week: number, totalWeeks: number): number {
    const total: number = totalWeeks < 1 ? 1 : totalWeeks;
    if (week < 1) {
      return 1;
    }
    if (week > total) {
      return total;
    }
    return week;
  }

  /** 第 N 周 → Swiper 的页下标（从 0 开始） */
  static pageOf(week: number): number {
    return week - 1;
  }

  /** Swiper 的页下标 → 第 N 周 */
  static weekOfPage(page: number): number {
    return page + 1;
  }

  /** 打开时选中哪一周：跟随当前日期（当前周），并夹在学期范围内 */
  static initialWeek(currentWeek: number, totalWeeks: number): number {
    return WeekSelection.clamp(currentWeek, totalWeeks);
  }

  /**
   * 这次 `onChange` 该不该当成"用户选了某一周"。
   *
   * @param pageWeek 回调传来的页对应的周次
   * @param selectedWeek 当前显示的周
   * @param autoScrolling 是否正处于程序化翻页
   */
  static shouldReport(pageWeek: number, selectedWeek: number, autoScrolling: boolean): boolean {
    return !autoScrolling && pageWeek !== selectedWeek;
  }
}
