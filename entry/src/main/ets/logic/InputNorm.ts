/**
 * 用户输入的宽容规范化（移植自 Android `object InputNorm`，行为逐条对齐）。
 *
 * 原则：**能自动纠正的就不报错**（"8:5"→"8:05"、"2026-9-1"→"2026-09-01"、"1~8周"→"1-8"），
 * 实在无法理解的才返回 null，由界面标红并写明格式要求。所有函数幂等。
 */
import { Minutes } from './Minutes.ts';
import { WeekCalculator } from './WeekCalculator.ts';
import { WeekMasks } from './WeekMasks.ts';

export class InputNorm {
  /** 全角数字与常见全角符号 → 半角；去掉首尾空白 */
  static halfWidth(raw: string): string {
    let out = '';
    for (const ch of raw.trim()) {
      const code = ch.codePointAt(0);
      if (code === undefined) {
        continue;
      }
      if (code >= 0xff10 && code <= 0xff19) {
        out += String.fromCharCode(0x30 + (code - 0xff10));
      } else if (ch === '：') {
        out += ':';
      } else if (ch === '－') {
        out += '-';
      } else if (ch === '～') {
        out += '~';
      } else if (ch === '，') {
        out += ',';
      } else {
        out += ch;
      }
    }
    return out;
  }

  /** 整数："５"→5；非法返回 null */
  static int(raw: string): number | null {
    const t = InputNorm.halfWidth(raw);
    if (!/^[+-]?\d+$/.test(t)) {
      return null;
    }
    const n = Number(t);
    return Number.isSafeInteger(n) ? n : null;
  }

  /**
   * 时间："8:5"→"8:05"、"08：00"→"8:00"、"8.5"→"8:05"、
   * "8"→"8:00"、"800"→"8:00"、"1945"→"19:45"。无法理解返回 null。
   */
  static time(raw: string): string | null {
    const t = InputNorm.halfWidth(raw).replace(/\s+/g, '');
    let h: number;
    let m: number;

    const colon = /^(\d{1,2})[:.](\d{1,2})$/.exec(t);
    const bare = /^(\d{1,4})$/.exec(t);

    if (colon !== null) {
      h = Number.parseInt(colon[1], 10);
      m = Number.parseInt(colon[2], 10);
    } else if (bare !== null) {
      const n = Number.parseInt(bare[1], 10);
      if (t.length <= 2) {
        h = n;
        m = 0;
      } else {
        h = Math.trunc(n / 100);
        m = n % 100;
      }
    } else {
      return null;
    }

    // 范围校验只有 `Minutes.of` 一份（与 PDF/OCR 的解析共用）
    const total: number | null = Minutes.of(h, m);
    return total === null ? null : Minutes.format(total);
  }

  /**
   * 日期："2026-9-1"→"2026-09-01"；分隔符接受 - / . 年 月，
   * 也接受纯数字 "20260901"。非法日期（如 2 月 30 日）返回 null。
   */
  static date(raw: string): string | null {
    const t = InputNorm.halfWidth(raw).replace(/\s+/g, '');
    const m =
      /^(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})日?$/.exec(t) ??
      /^(\d{4})(\d{2})(\d{2})$/.exec(t);
    if (m === null) {
      return null;
    }
    const y = Number.parseInt(m[1], 10);
    const mo = Number.parseInt(m[2], 10);
    const d = Number.parseInt(m[3], 10);
    // 日历合法性（含"2 月 30 日不许滚动成 3 月 2 日"的回读校验）只有
    // `WeekCalculator.epochDayOfIso` 一份：先拼成 ISO 再交给它，避免两处各判一次
    const iso: string =
      `${y}-${mo < 10 ? '0' : ''}${mo}-${d < 10 ? '0' : ''}${d}`;
    const epochDay: number | null = WeekCalculator.epochDayOfIso(iso);
    if (epochDay === null) {
      return null;
    }
    return iso;
  }

  /**
   * 周次："1－16"→"1-16"、"1~8周"→"1-8"、"1,3，5"→"1,3,5"、
   * "1-15周(单)"→"1-15单"，并压缩为规范写法（"1,2,3"→"1-3"）。解析不出任何一周返回 null。
   *
   * 刻意不做"宽松丢弃"：`WeekMasks.parse` 会跳过认不出的片段，
   * 于是手输的 "第1-3周" 会静默变成"只有第 3 周" —— 这种"看起来成功其实错了"
   * 比直接报错危险得多，所以这里先用字符白名单挡下来，交给界面提示格式。
   */
  static weeks(raw: string): string | null {
    const t = InputNorm.halfWidth(raw);
    if (t.length === 0 || !InputNorm.ALLOWED_WEEKS.test(t)) {
      return null;
    }
    if (!WeekMasks.isValid(t)) {
      return null;
    }
    return WeekMasks.format(WeekMasks.parse(t));
  }

  /**
   * 周次输入的字符白名单：数字、分隔符（- ~ – — , 、 空格）、"周"字、
   * 单双周标记（单/双）与括号。
   * 空格必须保留当分隔符 —— 去掉空格会让 "1 3"（第 1、3 周）变成 "13"（第 13 周）。
   */
  private static readonly ALLOWED_WEEKS: RegExp = /^[0-9~\-,\u2013\u2014\u3001 周单双()（）]+$/;
}
