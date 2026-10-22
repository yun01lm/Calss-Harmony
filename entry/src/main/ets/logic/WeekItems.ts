/**
 * 周视图的"每周色块"计算（移植自 Android `HomeViewModel` 的 `itemsByWeek` / `periodCount`）。
 *
 * 为什么把这件事从 UI 里拿出来：它决定了"这一周该看到哪些课"，是**正确性**问题，不是画法问题。
 * 放这里就能在 Node 上断言（周次掩码是否命中、冲突是否标出、自定义安排是否漏掉），
 * 而不必上模拟器逐周翻。
 *
 * 为什么一次算全部周（而不是只算当前周）：左右滑动切周时，每一页要渲染**自己那一周**的内容，
 * 否则滑动过程中会先看到当前周的课表再"跳"成目标周（Android 侧实测过）。
 * 20 周 × 几十条 = 百级运算，可以忽略。
 */
import { Conflicts } from './Conflicts.ts';
import { type ConflictMark, type GridSlot } from './Conflicts.ts';
import { Colors } from './Colors.ts';
import { Locations } from './Locations.ts';
import { WeekMasks } from './WeekMasks.ts';

/** 一个色块（课程或自定义安排）在某一周的一次出现 */
export interface WeekItem {
  /** 'course' | 'event' */
  readonly kind: string;
  readonly id: number;
  readonly title: string;
  /** 格子里显示的短副标题：课程=短教室，安排=备注 */
  readonly subtitle: string;
  readonly dayOfWeek: number;
  readonly startPeriod: number;
  readonly endPeriod: number;
  /** `#RRGGBB` */
  readonly color: string;
  /** 与它时间重叠的其他条目名称；空数组 = 不冲突 */
  readonly conflicts: string[];
}

/** 课程（只需要这几列） */
export interface CourseLike {
  readonly id: number;
  readonly name: string;
  readonly location: string;
  readonly color: number;
}

/** 上课时段 */
export interface ScheduleLike {
  readonly courseId: number;
  readonly dayOfWeek: number;
  readonly startPeriod: number;
  readonly endPeriod: number;
  /** 周次掩码（number；逻辑层内部转 bigint 判断） */
  readonly weekMask: number;
}

/** 自定义安排 */
export interface EventLike {
  readonly id: number;
  readonly title: string;
  readonly dayOfWeek: number;
  readonly startPeriod: number | null;
  readonly endPeriod: number | null;
  readonly weekMask: number;
  readonly color: number;
  readonly note: string;
}

/** 作息条目（只需要节次序号） */
export interface SlotLike {
  readonly periodIndex: number;
}

export interface WeekBuildInput {
  readonly courses: CourseLike[];
  readonly schedules: ScheduleLike[];
  readonly events: EventLike[];
  readonly totalWeeks: number;
}

export class WeekItems {
  static readonly KIND_COURSE: string = 'course';
  static readonly KIND_EVENT: string = 'event';

  /** 最少画几行（一学期只有 4 节课时，界面上也留出 8 节的网格，避免"半屏空着"） */
  static readonly MIN_PERIODS: number = 8;

  /**
   * 算出每一周的色块。
   *
   * @returns 长度 = totalWeeks 的数组，下标 0 是第 1 周
   */
  static build(input: WeekBuildInput): WeekItem[][] {
    const byId: Map<number, CourseLike> = new Map<number, CourseLike>();
    for (const c of input.courses) {
      byId.set(c.id, c);
    }

    const weeks: WeekItem[][] = [];
    for (let week = 1; week <= input.totalWeeks; week++) {
      const raw: WeekItem[] = [];

      for (const s of input.schedules) {
        const course: CourseLike | undefined = byId.get(s.courseId);
        // 课程被删了但时段还在（脏数据）→ 跳过，不要画一个没有名字的块
        if (course === undefined) {
          continue;
        }
        if (!WeekMasks.contains(BigInt(Math.trunc(s.weekMask)), week)) {
          continue;
        }
        const item: WeekItem = {
          kind: WeekItems.KIND_COURSE,
          id: course.id,
          title: course.name,
          // 格子里只放教室的短形式（格子只有 ~45vp 宽，完整教室名永远显示不全）；
          // 教师和完整教室在详情里
          subtitle: Locations.shortLocation(course.location),
          dayOfWeek: s.dayOfWeek,
          startPeriod: s.startPeriod,
          endPeriod: s.endPeriod,
          color: Colors.colorFor(course.name, course.color),
          conflicts: [],
        };
        raw.push(item);
      }

      for (const e of input.events) {
        if (!WeekMasks.contains(BigInt(Math.trunc(e.weekMask)), week)) {
          continue;
        }
        // 只有钟点、没有节次的安排本版不画进网格（节次是网格的纵轴）
        const sp: number | null = e.startPeriod;
        if (sp === null) {
          continue;
        }
        const item: WeekItem = {
          kind: WeekItems.KIND_EVENT,
          id: e.id,
          title: e.title,
          subtitle: e.note,
          dayOfWeek: e.dayOfWeek,
          startPeriod: sp,
          endPeriod: e.endPeriod === null ? sp : e.endPeriod,
          color: e.color !== 0 ? Colors.fromDb(e.color) : Colors.EVENT_COLOR,
          conflicts: [],
        };
        raw.push(item);
      }

      weeks.push(WeekItems.mark(raw));
    }
    return weeks;
  }

  /** 网格要画多少行：取"作息的最大节次 / 所有色的最大结束节次 / 至少 8"，与 Android 一致 */
  static periodCount(slots: SlotLike[], itemsByWeek: WeekItem[][]): number {
    let maxPeriod = 0;
    for (const s of slots) {
      if (s.periodIndex > maxPeriod) {
        maxPeriod = s.periodIndex;
      }
    }
    for (const week of itemsByWeek) {
      for (const item of week) {
        if (item.endPeriod > maxPeriod) {
          maxPeriod = item.endPeriod;
        }
      }
    }
    return Math.max(maxPeriod, WeekItems.MIN_PERIODS);
  }

  /** 取某一周的色块（越界返回空数组，不抛错） */
  static itemsOf(itemsByWeek: WeekItem[][], week: number): WeekItem[] {
    if (week < 1 || week > itemsByWeek.length) {
      return [];
    }
    return itemsByWeek[week - 1];
  }

  /**
   * 标出同一格时间重叠的条目。
   *
   * `Conflicts` 只认 `GridSlot`（更小的接口），所以这里先把要用的四个字段摊出来，
   * 再把结果按下标贴回去 —— 不把 `WeekItem` 硬塞给 `GridSlot[]`，避免依赖数组协变。
   */
  private static mark(items: WeekItem[]): WeekItem[] {
    const slots: GridSlot[] = [];
    for (const it of items) {
      const slot: GridSlot = {
        dayOfWeek: it.dayOfWeek,
        startPeriod: it.startPeriod,
        endPeriod: it.endPeriod,
        title: it.title,
      };
      slots.push(slot);
    }
    const marks: ConflictMark[] = Conflicts.markConflicts(slots);

    const out: WeekItem[] = [];
    for (let i = 0; i < items.length; i++) {
      const it: WeekItem = items[i];
      const merged: WeekItem = {
        kind: it.kind,
        id: it.id,
        title: it.title,
        subtitle: it.subtitle,
        dayOfWeek: it.dayOfWeek,
        startPeriod: it.startPeriod,
        endPeriod: it.endPeriod,
        color: it.color,
        conflicts: marks[i].conflicts,
      };
      out.push(merged);
    }
    return out;
  }
}
