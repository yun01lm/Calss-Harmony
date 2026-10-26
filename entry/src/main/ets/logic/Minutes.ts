/**
 * 一天内分钟数（0..1439）与 "H:mm" 互转。
 *
 * 结构与 Android `object Minutes` 一致：**静态类**而非散装导出函数。
 * 这样 `Minutes.format` / `WeekMasks.format` 天然分命名空间，逻辑层再大也不会撞名
 * （ArkTS 会直接报 `has already exported a member named 'format'`）。
 */
export class Minutes {
  /** `%d:%02d` —— 小时不补零、分钟补零（与 Android 一致） */
  static format(minute: number): string {
    const h = Math.trunc(minute / 60);
    const m = minute % 60;
    return `${h}:${m < 10 ? '0' : ''}${m}`;
  }

  /** 解析 "8:00" / "08:00" / "08：00"，非法返回 null */
  static parse(text: string): number | null {
    const m = /^(\d{1,2})[:：](\d{2})$/.exec(text.trim());
    if (m === null) {
      return null;
    }
    return Minutes.of(Number.parseInt(m[1], 10), Number.parseInt(m[2], 10));
  }

  /**
   * 时/分 → 当天分钟数，越界返回 null。
   *
   * 单独抽出来是为了**只有一份范围校验**：`Minutes.parse`（解析 PDF/OCR 里已经成形的
   * "8:00"）与 `InputNorm.time`（解析用户手输的 "8"、"800"、"8.5"）都需要它。
   * 各写一份的话迟早出现"手输能过、解析不过"这种只在某一个入口才踩得到的差异。
   */
  static of(hour: number, minute: number): number | null {
    if (!Number.isInteger(hour) || !Number.isInteger(minute)) {
      return null;
    }
    if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
      return null;
    }
    return hour * 60 + minute;
  }
}
