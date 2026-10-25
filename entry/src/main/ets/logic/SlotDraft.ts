/**
 * 作息表格编辑 / 校对页的规则（纯逻辑，Node 可测）。
 *
 * 移植自 Android `ui/timeslot/SlotEditDialog` + `ui/timetableimport/TimetableImportViewModel`
 * 的保存段。**手动编辑与导入校对共用同一套规则**（Android 也是共用一个弹窗），
 * 否则会出现"手动改能存、导入校对改就存不了"这种最难查的不一致。
 *
 * 三条原则与课程/安排表单一致：
 * 1. **能自动纠正的就不报错**：`8:5`→`8:05`、`800`→`8:00`、全角→半角，纠正后回填输入框；
 * 2. **纠正不了的才报错，并指明是哪一个框**（`badField`），不让人对着三个框猜；
 * 3. **节次号有上限**（`MAX_PERIOD`）：格子行数 = 最大节次，输错一个 999 会把周视图
 *    撑成 999 行（每行都要绘制），界面上看起来像卡死。
 */
import { InputNorm } from './InputNorm.ts';
import { Minutes } from './Minutes.ts';

/** 一条作息（节次 + 起止钟点） */
export interface SlotRow {
  readonly periodIndex: number;
  /** 上午 / 下午 / 晚上（可为空） */
  readonly label: string;
  /** 一天内分钟数，8:00 = 480 */
  readonly startMinute: number;
  readonly endMinute: number;
  /**
   * true = 节次号是导入时**推断**出来的（原文这一格没读出来）。
   * 校对页要标出来让人核对 —— 补号是好事，但必须让人知道哪几行是补的。
   */
  readonly inferred: boolean;
}

/** 编辑框里的原始文本（未规范化） */
export interface SlotForm {
  readonly periodText: string;
  readonly label: string;
  readonly startText: string;
  readonly endText: string;
}

/** 一次校验的产出（成功时 `error === ''`） */
export interface SlotCheckResult {
  readonly error: string;
  /** 出错的那一格：`BAD_PERIOD` / `BAD_START` / `BAD_END` / `''` */
  readonly badField: string;
  /** 规范化后的行（成功即用它写库；失败时也带出来，用于回填） */
  readonly row: SlotRow;
  /** 规范化后的文本（回填输入框：`8:5` → `8:05`） */
  readonly form: SlotForm;
}

export class SlotDraft {
  /**
   * 节次号上限。
   *
   * 为什么要卡：周视图的**行数就是最大节次号**（`WeekItems.periodCount`），
   * 一个手滑的 `999` 会让网格变成 999 行 × 7 列，滚动条一拉到底、界面像死机。
   * 30 足够任何学校的作息（真实课表里最多 13 节）。
   */
  static readonly MAX_PERIOD: number = 30;
  /** 一节课至少几分钟：更短的区间多半是把起止填反了 */
  static readonly MIN_DURATION: number = 1;
  /** 加一节时的默认时长（与 Android 一致） */
  static readonly DEFAULT_DURATION: number = 45;

  static readonly BAD_NONE: string = '';
  static readonly BAD_PERIOD: string = 'period';
  static readonly BAD_START: string = 'start';
  static readonly BAD_END: string = 'end';

  static readonly TIME_HINT: string = '格式 8:00；「8:5」「800」这类写法会自动纠正';

  /** 造一条作息行 */
  static row(
    periodIndex: number,
    label: string,
    startMinute: number,
    endMinute: number,
    inferred: boolean = false
  ): SlotRow {
    return {
      periodIndex: periodIndex,
      label: label,
      startMinute: startMinute,
      endMinute: endMinute,
      inferred: inferred,
    };
  }

  /** 造一份表单 */
  static form(periodText: string, label: string, startText: string, endText: string): SlotForm {
    return {
      periodText: periodText,
      label: label,
      startText: startText,
      endText: endText,
    };
  }

  /** 一条作息 → 表单文本（编辑时预填） */
  static of(row: SlotRow): SlotForm {
    return SlotDraft.form(
      String(row.periodIndex),
      row.label,
      Minutes.format(row.startMinute),
      Minutes.format(row.endMinute)
    );
  }

  /**
   * 校验 + 规范化。
   *
   * 顺序：节次号 → 开始 → 结束（含先后关系）。第一个错就是最该先修的那个。
   */
  static check(form: SlotForm, inferred: boolean = false): SlotCheckResult {
    const periodText: string = InputNorm.halfWidth(form.periodText);
    const label: string = form.label.trim();
    const startText: string = InputNorm.halfWidth(form.startText);
    const endText: string = InputNorm.halfWidth(form.endText);

    const period: number | null = InputNorm.int(periodText);
    const startMinute: number | null = SlotDraft.minuteOf(startText);
    const endMinute: number | null = SlotDraft.minuteOf(endText);

    // 无论成败都回填规范化文本（能补零的先补零），用户看得见改成了什么
    const fixedForm: SlotForm = SlotDraft.form(
      period === null ? periodText : String(period),
      label,
      startMinute === null ? startText : Minutes.format(startMinute),
      endMinute === null ? endText : Minutes.format(endMinute)
    );

    if (period === null || period < 1 || period > SlotDraft.MAX_PERIOD) {
      return SlotDraft.failed(
        '节次号要填 1 到 ' + SlotDraft.MAX_PERIOD + ' 之间的整数',
        SlotDraft.BAD_PERIOD, period, startMinute, endMinute, fixedForm, inferred
      );
    }
    if (startMinute === null) {
      return SlotDraft.failed(
        '开始时间没填对。' + SlotDraft.TIME_HINT,
        SlotDraft.BAD_START, period, startMinute, endMinute, fixedForm, inferred
      );
    }
    if (endMinute === null) {
      return SlotDraft.failed(
        '结束时间没填对。' + SlotDraft.TIME_HINT,
        SlotDraft.BAD_END, period, startMinute, endMinute, fixedForm, inferred
      );
    }
    if (endMinute - startMinute < SlotDraft.MIN_DURATION) {
      return SlotDraft.failed(
        '结束时间要晚于开始时间',
        SlotDraft.BAD_END, period, startMinute, endMinute, fixedForm, inferred
      );
    }
    const ok: SlotCheckResult = {
      error: '',
      badField: SlotDraft.BAD_NONE,
      row: SlotDraft.row(period, label, startMinute, endMinute, inferred),
      form: fixedForm,
    };
    return ok;
  }

  /**
   * 加一节：接在最后一节之后，时长沿用上一节（没有上一节就 8:00-8:45）。
   *
   * 为什么沿用时长而不是固定 45 分：不少学校一节课 40/50 分钟，
   * 补出来的一节如果总是 45 分，用户每次都要改两个时间。
   */
  static nextRow(rows: SlotRow[]): SlotRow {
    let last: SlotRow | null = null;
    for (const r of rows) {
      if (last === null || r.periodIndex > last.periodIndex) {
        last = r;
      }
    }
    const nextIndex: number = last === null ? 1 : Math.min(last.periodIndex + 1, SlotDraft.MAX_PERIOD);
    if (last === null) {
      return SlotDraft.row(nextIndex, SlotDraft.groupOf(nextIndex), 8 * 60, 8 * 60 + SlotDraft.DEFAULT_DURATION);
    }
    const duration: number = Math.max(SlotDraft.MIN_DURATION, last.endMinute - last.startMinute);
    let start: number = last.endMinute;
    // 上一节结束得太晚（比如 23:50）时不再往后堆：回到 8:00，让它是一节"待改"的新行
    if (start + duration > 23 * 60 + 59) {
      start = 8 * 60;
    }
    const end: number = Math.min(start + duration, 23 * 60 + 59);
    return SlotDraft.row(nextIndex, SlotDraft.groupOf(nextIndex), start, end);
  }

  /** 节次号 → 分组（与 Android 的 addPeriod 一致：1-4 上午，5-8 下午，其余晚上） */
  static groupOf(periodIndex: number): string {
    if (periodIndex <= 4) {
      return '上午';
    }
    if (periodIndex <= 8) {
      return '下午';
    }
    return '晚上';
  }

  /** 1..最大节次之间缺了哪些（校对页据此提示"缺第 N 节"） */
  static gapsOf(rows: SlotRow[]): number[] {
    let max = 0;
    const have: Set<number> = new Set<number>();
    for (const r of rows) {
      if (r.periodIndex > max) {
        max = r.periodIndex;
      }
      have.add(r.periodIndex);
    }
    const out: number[] = [];
    for (let p = 1; p <= max; p++) {
      if (!have.has(p)) {
        out.push(p);
      }
    }
    return out;
  }

  /**
   * 写库前的整表：按节次排序 + **同一节次只留第一条**。
   *
   * 为什么必须去重：校对页允许用户把两行改成同一个节次号。
   * 而库里 `time_slots` 允许重复的 periodIndex（没有唯一约束），
   * 重复行会让"第 3 节"在格子上算两次时间 —— 界面上就是行高莫名其妙变一半。
   */
  static sortedUnique(rows: SlotRow[]): SlotRow[] {
    const sorted: SlotRow[] = rows.slice().sort((a: SlotRow, b: SlotRow) => a.periodIndex - b.periodIndex);
    const seen: Set<number> = new Set<number>();
    const out: SlotRow[] = [];
    for (const r of sorted) {
      if (seen.has(r.periodIndex)) {
        continue;
      }
      seen.add(r.periodIndex);
      out.push(r);
    }
    return out;
  }

  /**
   * 与"当前作息有几节"对比的提示（Android `toResult` 里同一条规则）。
   *
   * 解析器自己看不出"整行没读出来"—— 它只知道自己读到了几行。
   * 拿现有节数一比，少了就把问题摆到用户面前。
   */
  static missingHint(existingCount: number, parsedCount: number): string {
    if (existingCount <= parsedCount) {
      return '';
    }
    return '当前作息有 ' + existingCount + ' 节，这次只认出 ' + parsedCount +
      ' 节，可能有整行没读出来 —— 请核对，缺的行点「补一节」加上';
  }

  /** 列表里的一行文案：「第 3 节 · 上午　9:55 - 10:40」 */
  static describe(row: SlotRow): string {
    const label: string = row.label.trim().length === 0
      ? SlotDraft.groupOf(row.periodIndex)
      : row.label.trim();
    return '第 ' + row.periodIndex + ' 节 · ' + label + '　' +
      Minutes.format(row.startMinute) + ' - ' + Minutes.format(row.endMinute);
  }

  /** `8:5` / `800` / `8.5` 都认；认不出返回 null */
  private static minuteOf(text: string): number | null {
    const normalized: string | null = InputNorm.time(text);
    if (normalized === null) {
      return null;
    }
    return Minutes.parse(normalized);
  }

  private static failed(
    error: string,
    badField: string,
    period: number | null,
    startMinute: number | null,
    endMinute: number | null,
    form: SlotForm,
    inferred: boolean
  ): SlotCheckResult {
    const out: SlotCheckResult = {
      error: error,
      badField: badField,
      // 失败时给一个"什么都不知道"的行：调用方不该拿它写库（error 非空即不写）
      row: SlotDraft.row(period === null ? 0 : period, form.label,
        startMinute === null ? 0 : startMinute, endMinute === null ? 0 : endMinute, inferred),
      form: form,
    };
    return out;
  }
}
