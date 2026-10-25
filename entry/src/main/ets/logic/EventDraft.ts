/**
 * 自定义安排编辑面板的"表单 → 可入库安排"（纯逻辑，Node 可测）。
 *
 * 移植自 Android `ui/edit/EventEditDialog` 的保存段。规则与 `CourseDraft` 同一套，
 * 但有四处**故意不同**，都是自定义安排自己的性质决定的：
 *
 * 1. **周次缺省是整学期**，不是课程的 `1-16`：安排是"这学期每周三去健身"这种整体安排，
 *    新学期 20 周却只画到第 16 周，用户会以为没保存上。Android 硬编码 `1-20`，
 *    这里改成按当前课表总周数生成（20 周学期结果完全一样）。
 * 2. **只有一段**（没有多行）：一条安排就是"某天某几节"。需要多个时段的，建两条安排；
 *    硬塞进一个表单反而要处理"删除第几段"，而安排没有"课程"那种整体身份。
 * 3. **没有教室/教师/教学班**：那些是课程字段；安排只在格子里显示标题与备注。
 * 4. **颜色 / 自由钟点（startMinute/endMinute）进了表单但只透传**：本版界面不编辑它们，
 *    但编辑一次就清空是不行的（老数据里可能有钟点定位的安排）。调用方负责把库里读到的
 *    原值传回来，这里不碰。
 *
 * 为什么单独成模块：`.ets` 页面没法在 Node 里跑测试（ArkUI 装饰器需要编译器），
 * 而"用户输入 → 数据库"这段是**唯一**能让一条安排变错的地方。
 */
import { CourseDraft } from './CourseDraft.ts';
import { InputNorm } from './InputNorm.ts';
import { WeekMasks } from './WeekMasks.ts';

/** 表单里的原始输入（未规范化） */
export interface EventDraftInput {
  readonly title: string;
  readonly note: string;
  /** 1 = 周一 … 7 = 周日 */
  readonly day: number;
  readonly start: number;
  readonly end: number;
  /** 用户输入的周次原文；规范化后的文本由 `check` 回填 */
  readonly weeks: string;
}

/** 一次校验的全部产出（成功时 `error === ''`） */
export interface EventDraftResult {
  readonly error: string;
  /**
   * 出错的那一格（`BAD_TITLE` / `BAD_WEEKS`；成功时是 `BAD_NONE`）。
   *
   * 为什么要单独给：只有一句错误文案时，界面只能猜着把哪个输入框标红；
   * 猜错了（标题空着、却把周次框标红）会让人一直改那个没错的格子。
   */
  readonly badField: string;
  readonly title: string;
  readonly note: string;
  readonly day: number;
  readonly start: number;
  readonly end: number;
  /** 规范化后的周次文本，用于回填输入框（`1~8周` → `1-8`） */
  readonly weeks: string;
  /** 只在成功时有效；失败时是 `0n`（调用方不该用它写库） */
  readonly weekMask: bigint;
}

export class EventDraft {
  static readonly WEEK_HINT: string =
    '格式：1-20、2,4,6-8 或 1-15单（单双周）；全角符号、「周」字保存时会自动纠正';
  static readonly BAD_NONE: string = '';
  static readonly BAD_TITLE: string = 'title';
  static readonly BAD_WEEKS: string = 'weeks';

  /** 造一份输入（`.ets` 里不能把对象字面量直接赋给只读接口，统一走这里） */
  static input(
    title: string,
    note: string,
    day: number,
    start: number,
    end: number,
    weeks: string
  ): EventDraftInput {
    return {
      title: title,
      note: note,
      day: day,
      start: start,
      end: end,
      weeks: weeks,
    };
  }

  /**
   * 点空白格新建时的默认值：该列星期、该行节次起、下一节止、整学期周次。
   *
   * 默认值一律**夹到合法范围**：切过课表、作息改短之后，格子里的节次可能已经超出
   * 当前 `periodCount`，直接用会让首次打开的表单就带着越界值。
   */
  static newInput(day: number, period: number, periodCount: number, totalWeeks: number): EventDraftInput {
    const count: number = EventDraft.periodCountOf(periodCount);
    const start: number = CourseDraft.clampPeriod(period, count);
    const end: number = start + 1 > count ? count : start + 1;
    return EventDraft.input('', '', CourseDraft.clampDay(day), start, end, EventDraft.defaultWeeks(totalWeeks));
  }

  /**
   * 新学期默认周次：`1-总周数`。
   *
   * 覆盖整学期是刻意的（见文件头 1）。总周数不合法时退回 16 周（课程的默认值），
   * 而不是退回 0 周 —— 空掩码的安排存不进库，也永远画不出来。
   */
  static defaultWeeks(totalWeeks: number): string {
    let weeks: number = 16;
    if (Number.isFinite(totalWeeks)) {
      const n: number = Math.trunc(totalWeeks);
      if (n >= 1 && n <= CourseDraft.MAX_STORABLE_WEEK) {
        weeks = n;
      }
    }
    return WeekMasks.format(WeekMasks.range(1, weeks));
  }

  /**
   * 校验 + 规范化。
   *
   * 顺序与 `CourseDraft.check` 一致：**标题 → 周次**。用户看到的第一个错误总是最该先修的那个，
   * 而不是"周次格式不对"盖住"还没填标题"。
   *
   * 起止节填反、星期/节次越界都**静默纠正**（与课程表单一致）：这些不是用户想表达的东西，
   * 报错只会让人卡在一个改不动的表单里。
   */
  static check(input: EventDraftInput, periodCount: number): EventDraftResult {
    const count: number = EventDraft.periodCountOf(periodCount);
    const title: string = input.title.trim();
    const note: string = input.note.trim();
    const day: number = CourseDraft.clampDay(input.day);
    const start: number = CourseDraft.clampPeriod(input.start, count);
    const end: number = CourseDraft.clampPeriod(input.end, count);
    const lo: number = Math.min(start, end);
    const hi: number = Math.max(start, end);
    const weeksText: string | null = InputNorm.weeks(input.weeks);
    // 无论成败都回填：用户能直接看见「1~8周」被改成了「1-8」
    const weeks: string = weeksText === null ? input.weeks : weeksText;

    if (title.length === 0) {
      return EventDraft.failed(
        '请输入标题（如：健身 / 自习）', EventDraft.BAD_TITLE, title, note, day, lo, hi, weeks
      );
    }
    if (weeksText === null) {
      return EventDraft.failed(
        '周次没填对。' + EventDraft.WEEK_HINT, EventDraft.BAD_WEEKS, title, note, day, lo, hi, weeks
      );
    }
    const mask: bigint = WeekMasks.parse(weeksText);
    if (mask >= EventDraft.storageLimit()) {
      // 与存储边界对齐（`models.maskToDb` 的上限 2^53）：不拦下来的话能过表单、
      // 写库时才抛错，界面表现是"点了保存什么都没发生"（课程表单踩过同一个坑）
      return EventDraft.failed(
        '周次超出可保存范围（最多第 ' + CourseDraft.MAX_STORABLE_WEEK + ' 周）',
        EventDraft.BAD_WEEKS, title, note, day, lo, hi, weeks
      );
    }
    const ok: EventDraftResult = {
      error: '',
      badField: EventDraft.BAD_NONE,
      title: title,
      note: note,
      day: day,
      start: lo,
      end: hi,
      weeks: weeks,
      weekMask: mask,
    };
    return ok;
  }

  /** 详情卡里那一行「周一 第 3-4 节」；单节时不写成「第 3-3 节」 */
  static periodText(day: number, start: number, end: number): string {
    const periods: string = start === end ? '第 ' + start + ' 节' : '第 ' + start + '-' + end + ' 节';
    return CourseDraft.dayName(day) + ' ' + periods;
  }

  private static failed(
    error: string,
    badField: string,
    title: string,
    note: string,
    day: number,
    start: number,
    end: number,
    weeks: string
  ): EventDraftResult {
    const out: EventDraftResult = {
      error: error,
      badField: badField,
      title: title,
      note: note,
      day: day,
      start: start,
      end: end,
      weeks: weeks,
      weekMask: BigInt(0),
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

  /** 2^53：库里能精确表示的掩码上界（与 `models.maskToDb`、`CourseDraft` 同一个数） */
  private static storageLimit(): bigint {
    return BigInt(1) << BigInt(CourseDraft.MAX_STORABLE_WEEK);
  }
}
