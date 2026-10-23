/**
 * 课程编辑面板的"表单 → 可入库时段"（纯逻辑，Node 可测）。
 *
 * 移植自 Android `ui/edit/CourseEditDialog` 的保存段，规则逐条对齐：
 *
 * 1. **能自动纠正的就不报错**：周次先走 `InputNorm.weeks`（全角→半角、`1~8周`→`1-8`、
 *    `1,2,3`→`1-3`），纠正后的文本回填到输入框，用户能看见改成了什么。
 * 2. **起止节填反自动对调**：填 `第 5 节 ~ 第 3 节` 的人是"先点了下面"，不是想表达空区间。
 * 3. **星期/节次夹到合法范围**：切过课表、作息改短之后，草稿里可能留着已经不存在的节次；
 *    越界直接夹住而不是报错，否则用户会被卡在一个没法修的表单里。
 * 4. 周次解析不出任何一周**才**报错，并在返回里指明是第几段 —— 整段表单一起标红找不着北。
 *
 * 为什么单独成模块：这段规则是"用户输入 → 数据库"的唯一关口，
 * 而 `.ets` 页面没法在 Node 里跑测试（ArkUI 装饰器需要编译器）。
 * 放在 `logic/` 里就能用真实断言覆盖（见 `tests/course-draft.test.ts`）。
 */
import { InputNorm } from './InputNorm.ts';
import { WeekMasks } from './WeekMasks.ts';

/** 表单里的一行"上课时段" */
export interface DraftRow {
  /** 1 = 周一 … 7 = 周日 */
  readonly day: number;
  readonly start: number;
  readonly end: number;
  /** 用户原始输入（未规范化）；规范化后的文本由 `check` 回填 */
  readonly weeks: string;
}

/** 校验通过、可直接入库的一段时段；`weekMask` 用 bigint，交给 `maskToDb` 在库边界转换 */
export interface DraftSchedule {
  readonly dayOfWeek: number;
  readonly startPeriod: number;
  readonly endPeriod: number;
  readonly weekMask: bigint;
}

/** 一次校验的全部产出（成功时 `error === ''`） */
export interface DraftResult {
  readonly error: string;
  /** 出错的行下标；-1 表示不是某一行的错（如课程名为空） */
  readonly badRow: number;
  readonly name: string;
  readonly teacher: string;
  readonly location: string;
  /** 规范化后的行（周次已纠正、起止节已对调并夹住），用于回填输入框 */
  readonly rows: DraftRow[];
  readonly schedules: DraftSchedule[];
}

/** 保存时交给数据层的载荷（只剩"能入库"的部分） */
export interface CourseDraftPayload {
  readonly name: string;
  readonly teacher: string;
  readonly location: string;
  readonly schedules: DraftSchedule[];
}

export class CourseDraft {
  static readonly MAX_DAY: number = 7;
  static readonly BAD_ROW_NONE: number = -1;
  static readonly WEEK_HINT: string =
    '格式：1-16、2,4,6-8 或 1-15单（单双周）；全角符号、「周」字保存时会自动纠正';

  /** 造一行草稿（`.ets` 里不能用对象字面量直接赋给只读接口，统一走这里） */
  static row(day: number, start: number, end: number, weeks: string): DraftRow {
    return { day: day, start: start, end: end, weeks: weeks };
  }

  /** 点空白格新建时的默认行：该列星期、该行节次起、下一节止 */
  static newRow(day: number, period: number, periodCount: number): DraftRow {
    const count: number = CourseDraft.periodCountOf(periodCount);
    const start: number = CourseDraft.clampPeriod(period, count);
    const end: number = start + 1 > count ? count : start + 1;
    return CourseDraft.row(CourseDraft.clampDay(day), start, end, '1-16');
  }

  static dayName(day: number): string {
    switch (CourseDraft.clampDay(day)) {
      case 1: return '周一';
      case 2: return '周二';
      case 3: return '周三';
      case 4: return '周四';
      case 5: return '周五';
      case 6: return '周六';
      default: return '周日';
    }
  }

  /** 编辑框里显示的长度摘要，如「周一 3-4 节 · 1-16 周」 */
  static rowSummary(row: DraftRow): string {
    return (
      CourseDraft.dayName(row.day) +
      ' ' + row.start + '-' + row.end + ' 节 · ' +
      (row.weeks.trim().length === 0 ? '未填周次' : row.weeks.trim()) + ' 周'
    );
  }

  static clampDay(day: number): number {
    if (!Number.isFinite(day)) {
      return 1;
    }
    const n: number = Math.trunc(day);
    if (n < 1) {
      return 1;
    }
    return n > CourseDraft.MAX_DAY ? CourseDraft.MAX_DAY : n;
  }

  static clampPeriod(period: number, periodCount: number): number {
    const count: number = CourseDraft.periodCountOf(periodCount);
    if (!Number.isFinite(period)) {
      return 1;
    }
    const n: number = Math.trunc(period);
    if (n < 1) {
      return 1;
    }
    return n > count ? count : n;
  }

  /**
   * 校验 + 规范化。
   *
   * 顺序刻意是"名称 → 行数 → 周次"：与 Android 一致，用户看到的第一个错误
   * 总是最该先修的那个，而不是"周次格式不对"盖住"还没填课程名"。
   */
  static check(
    rawName: string,
    rawTeacher: string,
    rawLocation: string,
    rows: DraftRow[],
    periodCount: number
  ): DraftResult {
    const count: number = CourseDraft.periodCountOf(periodCount);
    const name: string = rawName.trim();
    const teacher: string = rawTeacher.trim();
    const location: string = rawLocation.trim();

    // 先把每一行规范化（不做判断），无论最后是否通过都要回填给输入框
    const fixed: DraftRow[] = [];
    let badRow: number = CourseDraft.BAD_ROW_NONE;
    for (let i = 0; i < rows.length; i++) {
      const r: DraftRow = rows[i];
      const weeksText: string | null = InputNorm.weeks(r.weeks);
      const start: number = CourseDraft.clampPeriod(r.start, count);
      const end: number = CourseDraft.clampPeriod(r.end, count);
      const lo: number = Math.min(start, end);
      const hi: number = Math.max(start, end);
      if (weeksText === null && badRow === CourseDraft.BAD_ROW_NONE) {
        badRow = i;
      }
      fixed.push(
        CourseDraft.row(
          CourseDraft.clampDay(r.day),
          lo,
          hi,
          weeksText === null ? r.weeks : weeksText
        )
      );
    }

    if (name.length === 0) {
      return CourseDraft.failed('请输入课程名称', CourseDraft.BAD_ROW_NONE, name, teacher, location, fixed);
    }
    if (fixed.length === 0) {
      return CourseDraft.failed('至少需要一个上课时段', CourseDraft.BAD_ROW_NONE, name, teacher, location, fixed);
    }
    if (badRow !== CourseDraft.BAD_ROW_NONE) {
      return CourseDraft.failed(
        '第 ' + (badRow + 1) + ' 段的周次没填对。' + CourseDraft.WEEK_HINT,
        badRow, name, teacher, location, fixed
      );
    }

    const schedules: DraftSchedule[] = [];
    for (const r of fixed) {
      schedules.push({
        dayOfWeek: r.day,
        startPeriod: r.start,
        endPeriod: r.end,
        weekMask: WeekMasks.parse(r.weeks),
      });
    }
    const ok: DraftResult = {
      error: '',
      badRow: CourseDraft.BAD_ROW_NONE,
      name: name,
      teacher: teacher,
      location: location,
      rows: fixed,
      schedules: schedules,
    };
    return ok;
  }

  /** 成功时的载荷；`check` 报错时返回 null */
  static payloadOf(result: DraftResult): CourseDraftPayload | null {
    if (result.error.length > 0) {
      return null;
    }
    const out: CourseDraftPayload = {
      name: result.name,
      teacher: result.teacher,
      location: result.location,
      schedules: result.schedules,
    };
    return out;
  }

  private static failed(
    error: string,
    badRow: number,
    name: string,
    teacher: string,
    location: string,
    rows: DraftRow[]
  ): DraftResult {
    const out: DraftResult = {
      error: error,
      badRow: badRow,
      name: name,
      teacher: teacher,
      location: location,
      rows: rows,
      schedules: [],
    };
    return out;
  }

  private static periodCountOf(periodCount: number): number {
    if (!Number.isFinite(periodCount)) {
      return 1;
    }
    const n: number = Math.trunc(periodCount);
    return n < 1 ? 1 : n;
  }
}
