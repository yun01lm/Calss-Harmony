/**
 * 导入结果的"按课程合并"（对应 Android `pdf/SchedulePdfParser.kt` 的 `merge()`）。
 *
 * **为什么必须有这一步**：两个解析器都是**按格子/按段落输出**的 —— 一门课
 * 星期几上两次，就产出两条 `RawCourse`。Android 在解析后统一按
 * 「名称 + 教师 + 地点」归并成"一门课 + 多个上课时段"，这里是同一件事的 TS 版。
 *
 * 不合并的后果（都是实测/审计出来的）：
 * 1. 一门课 2 次课 → 库里 **2 条课程行**，改一门、删一门都只动一半；
 * 2. `mergeCourses` 的"同名更新"会把两条都更新到同一行（键索引里只有旧行），
 *    另一条从此永远不再更新 —— 越导越脏；
 * 3. 预览里"认出 N 门课"的数字虚高（24 门里可能有重复）。
 *
 * 纯函数、零平台依赖，可以在 Node 上直接跑断言（`tests/course-merge.test.ts`）。
 */
import { type Course, type CourseSchedule, type CourseWithSchedules } from './models.ts';

/** 合并结果 */
export interface MergeOutcome {
  readonly items: CourseWithSchedules[];
  /** 一个上课时段都没认出来的课程名：这些课程留着也画不出来，丢掉但**要报给用户** */
  readonly dropped: string[];
  /** 被合并掉的重复时段条数（同一门课的同一段时间） */
  readonly duplicateSchedules: number;
}

interface Group {
  readonly course: Course;
  readonly schedules: CourseSchedule[];
  /** 已经加进来的时段，用来去重（"周二 3-4 节 1-16 周"重复出现时只留一条） */
  readonly seen: Map<string, boolean>;
  /** 至少有一条时段是真能画出来的（掩码非 0） */
  hasVisible: boolean;
  /** 第一个非空教室：课程自身的 `location` 为空时用它兜底（旧数据的显示） */
  firstLocation: string;
}

/**
 * 课程的唯一键：名称 + 教师 + 教学班。
 *
 * **地点不参与**（v3）：教室跟着每条时段走，同一门课在不同楼上完全正常。
 * **教学班参与**（v4）：同一位老师带两个班、课名相同时，那是两门不同的课 ——
 * 不带班级就会并成一门，删一门课会把另一门一起删掉。
 *
 * 一门课的多个时段，班级一般相同；万一来料不一致，就按"班级集合"归并（排序后拼起来），
 * 保证同一个集合总是同一个键。
 *
 * 与 `ScheduleStore` 判断"是不是同一门课"必须用同一个键，所以那边直接调这里。
 */
export function courseKeyOf(course: Course, schedules: CourseSchedule[]): string {
  return course.name.trim() + '\u0001' + course.teacher.trim() + '\u0001' + classGroupKeyOf(schedules);
}

/** 一组时段的"班级集合"键：去重、排序、用 `|` 拼（`''` 表示一个班都没写） */
export function classGroupKeyOf(schedules: CourseSchedule[]): string {
  const groups: string[] = [];
  for (const s of schedules) {
    const g: string = s.classGroup.trim();
    if (g.length > 0 && groups.indexOf(g) < 0) {
      groups.push(g);
    }
  }
  groups.sort();
  return groups.join('|');
}

/** 一条时段能否真的在网格上出现（掩码 0 = 每周都不上 = 永远不出现） */
function isVisible(s: CourseSchedule): boolean {
  return Number.isFinite(s.weekMask) && s.weekMask !== 0;
}

function scheduleKey(s: CourseSchedule): string {
  return `${s.dayOfWeek}|${s.startPeriod}|${s.endPeriod}|${s.weekMask}|${s.location}`;
}

/**
 * 把"每格/每段一条"的解析结果合并成"一门课 + 多个时段"。
 *
 * 顺序保持首次出现的顺序（预览里的顺序与 PDF 阅读顺序一致，用户好核对）。
 */
export function mergeCourseItems(items: CourseWithSchedules[]): MergeOutcome {
  const order: string[] = [];
  const groups: Map<string, Group> = new Map<string, Group>();
  const dropped: string[] = [];
  let duplicateSchedules = 0;

  for (const item of items) {
    const key: string = courseKeyOf(item.course, item.schedules);
    let group: Group | undefined = groups.get(key);
    if (group === undefined) {
      const g: Group = {
        course: item.course,
        schedules: [],
        seen: new Map<string, boolean>(),
        hasVisible: false,
        firstLocation: item.course.location.trim(),
      };
      groups.set(key, g);
      order.push(key);
      group = g;
    }

    for (const s of item.schedules) {
      const sk: string = scheduleKey(s);
      if (group.seen.has(sk)) {
        duplicateSchedules++;
        continue;
      }
      group.seen.set(sk, true);
      group.schedules.push(s);
      if (isVisible(s)) {
        group.hasVisible = true;
      }
      if (group.firstLocation.length === 0 && s.location.trim().length > 0) {
        group.firstLocation = s.location.trim();
      }
    }
  }

  const out: CourseWithSchedules[] = [];
  for (const key of order) {
    const g: Group | undefined = groups.get(key);
    if (g === undefined) {
      continue;
    }
    if (!g.hasVisible) {
      // 一条能画的时段都没有：留在库里等于"看不见的数据"，宁可明说
      dropped.push(g.course.name);
      continue;
    }
    // 去掉掩码为 0 的时段（同一门课其它时段是好的，就只丢这一条）
    const visible: CourseSchedule[] = [];
    for (const s of g.schedules) {
      if (isVisible(s)) {
        visible.push(s);
      }
    }
    // 课程自身的 location 为空时，用第一条时段的教室兜底：旧数据/旧界面都只认课程地点
    const course: Course = g.course.location.trim().length > 0 || g.firstLocation.length === 0
      ? g.course
      : {
        id: g.course.id,
        timetableId: g.course.timetableId,
        name: g.course.name,
        teacher: g.course.teacher,
        location: g.firstLocation,
        color: g.course.color,
        category: g.course.category,
        note: g.course.note,
      };
    const merged: CourseWithSchedules = { course: course, schedules: visible };
    out.push(merged);
  }

  const result: MergeOutcome = {
    items: out,
    dropped: dropped,
    duplicateSchedules: duplicateSchedules,
  };
  return result;
}
