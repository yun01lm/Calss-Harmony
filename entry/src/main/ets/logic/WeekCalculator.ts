/**
 * 周次计算（移植自 Android `object WeekCalculator`，语义逐条对齐）。
 *
 * **设计决定：全部用"epoch 天数"（epochDay，自 1970-01-01 起的整数天）做运算，
 * 不把 Date 传进来、也不做任何时区换算。**
 *
 * 原因：`java.time.LocalDate` 是无时区的"日历日期"，而 JS 的 `Date` 是 UTC 毫秒时间戳；
 * 用 Date 相减做"差几天"在跨夏令时/跨时区时会差 1，直接导致"第几周"错一周
 * （用户报过"该第 5 周却显示第 1 周"）。整数天运算没有这个问题，
 * 且与数据库里存的 `startDateEpochDay`（INTEGER）完全一致。
 *
 * 只在两个边界把"本地日期"转成 epochDay：`todayEpochDay()` 与 `epochDayOf()`。
 */
export interface Ymd {
  readonly year: number;
  readonly month: number;
  readonly day: number;
}

export class WeekCalculator {
  static readonly DAYS_PER_WEEK: number = 7;

  /** 由"日历日期"算 epochDay（UTC 语义，避开夏令时）。不校验合法性 */
  static epochDayOf(year: number, month1to12: number, day: number): number {
    const ms = Date.UTC(year, month1to12 - 1, day);
    return Math.floor(ms / 86400000);
  }

  /** epochDay → 日历日期 */
  static dateOf(epochDay: number): Ymd {
    const d = new Date(epochDay * 86400000);
    const out: Ymd = {
      year: d.getUTCFullYear(),
      month: d.getUTCMonth() + 1,
      day: d.getUTCDate(),
    };
    return out;
  }

  /** 今天（按**设备本地**日期）的 epochDay —— 应用里唯一需要"当前时间"的地方 */
  static todayEpochDay(now: Date = new Date()): number {
    return WeekCalculator.epochDayOf(now.getFullYear(), now.getMonth() + 1, now.getDate());
  }

  /** 星期几：1=周一 … 7=周日（1970-01-01 是周四） */
  static weekdayOfEpochDay(epochDay: number): number {
    const raw = (((epochDay + 3) % 7) + 7) % 7;
    return raw + 1;
  }

  /** 该 epochDay 所在周的周一 */
  static mondayOfEpochDay(epochDay: number): number {
    return epochDay - (WeekCalculator.weekdayOfEpochDay(epochDay) - 1);
  }

  /**
   * 由学期起始日（第一周周一）推算今天是第几周；学期开始前按第 1 周计。
   * 与 Android 完全一致：`(days / 7 + 1)`，向零取整等价于 Math.floor。
   */
  static currentWeek(startEpochDay: number, today: number): number {
    const days = today - startEpochDay;
    return Math.max(1, Math.floor(days / WeekCalculator.DAYS_PER_WEEK) + 1);
  }

  /**
   * 「这周是第 N 周」→ 反推开学日期（第一周的周一）。
   *
   * 与 [currentWeek] 严格互逆：`currentWeek(startDateForWeek(n, t), t) === n`。
   * 存在的理由：开学日期学生报不出来，而"这周第几周"人人知道；
   * 默认值只能取"创建课表时的当周周一"，会导致新表永远显示第 1 周。
   */
  static startDateForWeek(week: number, today: number): number {
    const n = Math.max(0, Math.trunc(week) - 1);
    return WeekCalculator.mondayOfEpochDay(today) - n * WeekCalculator.DAYS_PER_WEEK;
  }

  /**
   * "yyyy-MM-dd" → epochDay，`isoDate` 的逆运算。非法或不存在的日期（2 月 30 日）返回 null。
   *
   * 回读校验是必须的：`Date.UTC(2026, 1, 30)` 会静默滚成 3 月 2 日，
   * 于是"填错的开学日"会变成一个看着正常的日期，把整学期的周次都推错。
   */
  static epochDayOfIso(iso: string): number | null {
    const m: RegExpExecArray | null = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso.trim());
    if (m === null) {
      return null;
    }
    const y: number = Number.parseInt(m[1], 10);
    const mo: number = Number.parseInt(m[2], 10);
    const d: number = Number.parseInt(m[3], 10);
    const epochDay: number = WeekCalculator.epochDayOf(y, mo, d);
    const back: Ymd = WeekCalculator.dateOf(epochDay);
    if (back.year !== y || back.month !== mo || back.day !== d) {
      return null;
    }
    return epochDay;
  }

  /** "yyyy-MM-dd"（与 Android 的 ISO 输出一致，用于界面回填与日志） */
  static isoDate(epochDay: number): string {
    const ymd = WeekCalculator.dateOf(epochDay);
    const mm = ymd.month < 10 ? `0${ymd.month}` : `${ymd.month}`;
    const dd = ymd.day < 10 ? `0${ymd.day}` : `${ymd.day}`;
    return `${ymd.year}-${mm}-${dd}`;
  }
}
