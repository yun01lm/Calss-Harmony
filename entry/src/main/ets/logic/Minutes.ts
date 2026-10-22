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
    const h = Number.parseInt(m[1], 10);
    const min = Number.parseInt(m[2], 10);
    if (h < 0 || h > 23 || min < 0 || min > 59) {
      return null;
    }
    return h * 60 + min;
  }
}
