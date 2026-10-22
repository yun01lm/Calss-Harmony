/**
 * 周次位掩码（移植自 Android `object WeekMasks`，行为逐条对齐）。
 *
 * bit0 = 第 1 周。"本周上不上" = 一次按位与。
 *
 * **为什么用 bigint 而不是 number**：Android 侧是 64 位 `Long`，容量 `MAX_WEEK = 64`；
 * 而 JS 的位运算只有 **32 位有符号**语义 —— 用 number 存掩码，第 32 周之后会静默出错。
 * bigint 与 Long 语义一致，ArkTS 支持（已实测编进 HAP）。
 * 与数据库交界处做显式转换：`BigInt(row.weekMask)` / `Number(mask)`。
 */
export class WeekMasks {
  /** 掩码容量上限。实际学期 ≤ 30 周，留到 64 是为将来（暑假安排等）留余量 */
  static readonly MAX_WEEK: number = 64;

  /** 单周掩码。超出 1..MAX_WEEK 视为非法输入（与 Android 的 require 一致，抛错而非静默） */
  static of(week: number): bigint {
    if (!Number.isInteger(week) || week < 1 || week > WeekMasks.MAX_WEEK) {
      throw new RangeError(`week out of range: ${week}`);
    }
    return 1n << BigInt(week - 1);
  }

  /** 区间掩码：自动处理 start > end，并夹到 1..MAX_WEEK */
  static range(start: number, end: number): bigint {
    const lo = WeekMasks.clampWeek(Math.min(start, end));
    const hi = WeekMasks.clampWeek(Math.max(start, end));
    let mask = 0n;
    for (let w = lo; w <= hi; w++) {
      mask |= WeekMasks.of(w);
    }
    return mask;
  }

  /** 某周是否包含在掩码里（超出 1..MAX_WEEK 一律 false，不抛错） */
  static contains(mask: bigint, week: number): boolean {
    if (!Number.isInteger(week) || week < 1 || week > WeekMasks.MAX_WEEK) {
      return false;
    }
    return (mask & WeekMasks.of(week)) !== 0n;
  }

  /**
   * 解析用户输入 / PDF 里的周次写法：
   * `1-16`、`11`、`2-8,10-16`、`1-12周`、`1~8`、`1–16`（en dash）、
   * 以及**单双周**：`1-15周(单)`、`2-16双`、`1-16单周`。
   *
   * 单双周是实测必需：某校导出的课表写作 `(9-10节)1-15周(单)`，
   * 旧实现把 `15(单)` 解析失败后只留下"第 1 周"，等于整门课的周次全错。
   *
   * 无法识别的片段**整段忽略**（不猜测）；调用方应先用 `InputNorm.weeks` 做白名单校验，
   * 避免"第1-3周"这类未知写法被悄悄解析成"第 3 周"。
   */
  static parse(text: string): bigint {
    let t = text.replace(/周/g, '');
    const oddOnly = t.includes('单');
    const evenOnly = t.includes('双');
    t = t.replace(/[()（）单双]/g, ' ');

    let mask = 0n;
    for (const part of t.split(/[,，、\s]+/)) {
      const p = part.trim();
      if (p.length === 0) {
        continue;
      }
      const nums: number[] = [];
      for (const seg of p.split(/[-~–—]+/)) {
        const s = seg.trim();
        if (/^\d+$/.test(s)) {
          nums.push(Number.parseInt(s, 10));
        }
      }

      if (nums.length >= 2) {
        const lo = Math.min(nums[0], nums[1]);
        const hi = Math.max(nums[0], nums[1]);
        for (let w = lo; w <= hi; w++) {
          if (w >= 1 && w <= WeekMasks.MAX_WEEK && WeekMasks.passesParity(w, oddOnly, evenOnly)) {
            mask |= WeekMasks.of(w);
          }
        }
      } else if (nums.length === 1) {
        const w = nums[0];
        if (w >= 1 && w <= WeekMasks.MAX_WEEK && WeekMasks.passesParity(w, oddOnly, evenOnly)) {
          mask |= WeekMasks.of(w);
        }
      }
    }
    return mask;
  }

  /**
   * 格式化为 `1-12,14` 风格（编辑框回填用）。
   * 纯单/双周且 ≥4 周时压成 `1-15单` / `2-16双`。
   */
  static format(mask: bigint): string {
    if (mask === 0n) {
      return '';
    }
    const weeks: number[] = [];
    for (let w = 1; w <= WeekMasks.MAX_WEEK; w++) {
      if (WeekMasks.contains(mask, w)) {
        weeks.push(w);
      }
    }

    if (weeks.length >= 4) {
      let step2 = true;
      for (let i = 0; i + 1 < weeks.length; i++) {
        if (weeks[i + 1] - weeks[i] !== 2) {
          step2 = false;
          break;
        }
      }
      let allOdd = true;
      let allEven = true;
      for (const w of weeks) {
        if (w % 2 === 1) {
          allEven = false;
        } else {
          allOdd = false;
        }
      }
      if (step2 && (allOdd || allEven)) {
        return `${weeks[0]}-${weeks[weeks.length - 1]}${allOdd ? '单' : '双'}`;
      }
    }

    const parts: string[] = [];
    let i = 0;
    while (i < weeks.length) {
      let j = i;
      while (j + 1 < weeks.length && weeks[j + 1] === weeks[j] + 1) {
        j++;
      }
      parts.push(j === i ? `${weeks[i]}` : `${weeks[i]}-${weeks[j]}`);
      i = j + 1;
    }
    return parts.join(',');
  }

  /** 输入是否可用（解析后非空） */
  static isValid(text: string): boolean {
    return WeekMasks.parse(text) !== 0n;
  }

  /** 单周只要奇数周、双周只要偶数周 */
  private static passesParity(week: number, oddOnly: boolean, evenOnly: boolean): boolean {
    if (oddOnly && week % 2 === 0) {
      return false;
    }
    if (evenOnly && week % 2 === 1) {
      return false;
    }
    return true;
  }

  private static clampWeek(w: number): number {
    if (w < 1) {
      return 1;
    }
    return w > WeekMasks.MAX_WEEK ? WeekMasks.MAX_WEEK : w;
  }
}
