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
 * ## v5：教学班用**集合交集**判断，而不是字符串相等
 *
 * v4 用「名称 + 教师 + 教学班串」当键，修掉了"同老师带两个班被并成一门"；
 * 但它对**同一个班的不同写法**过敏：真实课表里同一门课的两次课，一次写
 * `计科2509班`、另一次写 `计科2509班;计科2510班`（合班上课），字符串不等 →
 * 被拆成两门课，于是又回到"改一门只改一半"。
 *
 * 现在改成：**名称与教师相同，且两边的教学班集合有交集** → 同一门课。
 * - `{计科2509}` ∩ `{计科2509,计科2510}` ≠ ∅ → 合并（合班上课）
 * - `{计科2509}` ∩ `{软件2501}` = ∅ → 不合并（同老师带两个班，确实是两门课）
 * - 两边都没有教学班信息 → 合并（沿用 v3 行为：只能靠名称+教师）
 * - **只有一边为空 → 不合并**：教学班丢了一半时，并错（删一门删掉两门）比拆开更糟，
 *   拆开至少用户能在预览里看出"同名两门"。
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

/**
 * 一门课的"身份"：名称 + 教师 + 教学班集合。
 *
 * 为什么单独成类型而不是拼成一个字符串：**"是否同一门课"不再是字符串相等**，
 * 而是"教学班集合有没有交集"，后者需要保留集合本身。
 */
export interface CourseIdentity {
  readonly name: string;
  readonly teacher: string;
  /** 去重后的教学班（`''` 不算一个班） */
  readonly groups: string[];
}

interface Group {
  readonly course: Course;
  /** 合并过程中会变（教学班取并集） */
  identity: CourseIdentity;
  readonly schedules: CourseSchedule[];
  /** 已经加进来的时段，用来去重（"周二 3-4 节 1-16 周"重复出现时只留一条） */
  readonly seen: Map<string, boolean>;
  /** 至少有一条时段是真能画出来的（掩码非 0） */
  hasVisible: boolean;
  /** 第一个非空教室：课程自身的 `location` 为空时用它兜底（旧数据的显示） */
  firstLocation: string;
}

/**
 * 一组时段里出现过的教学班（**拆开**、去重、排序；空串不算）。
 *
 * 必须拆：库里每条时段的 `classGroup` 是一个**串**（解析器把合班写成
 * `计科2509班;计科2510班`），而"是不是同一个班"要按**单个班**比。
 * 不拆的话 `计科2509班` 与 `计科2509班;计科2510班` 永远是两个不相等的字符串，
 * 合班上课的同一门课就会被拆成两门 —— 正是 v5 要修的那个问题。
 *
 * 分隔符取解析器可能产出的全部：`;` `；` `、` `,` `，` `/` 与空白。
 */
export function groupsOf(schedules: CourseSchedule[]): string[] {
  const out: string[] = [];
  for (const s of schedules) {
    for (const part of s.classGroup.split(/[;；、,，\/\s]+/)) {
      const g: string = part.trim();
      if (g.length > 0 && out.indexOf(g) < 0) {
        out.push(g);
      }
    }
  }
  out.sort();
  return out;
}

/** 取一门课的身份 */
export function identityOf(course: Course, schedules: CourseSchedule[]): CourseIdentity {
  const identity: CourseIdentity = {
    name: course.name.trim(),
    teacher: course.teacher.trim(),
    groups: groupsOf(schedules),
  };
  return identity;
}

/**
 * 两门课是不是同一门（见文件头 v5 的四条规则）。
 *
 * 注意这**不是**等价关系（"只有一边为空"会让传递性失效），所以归并时
 * 不能先排序再线性扫描，而是每次和历史分组逐个比，并且把"同时命中多个分组"
 * 的情况并成一个（见 `mergeCourseItems`）。
 */
export function sameCourse(a: CourseIdentity, b: CourseIdentity): boolean {
  if (a.name !== b.name || a.teacher !== b.teacher) {
    return false;
  }
  if (a.groups.length === 0 || b.groups.length === 0) {
    return a.groups.length === 0 && b.groups.length === 0;
  }
  for (const g of a.groups) {
    if (b.groups.indexOf(g) >= 0) {
      return true;
    }
  }
  return false;
}

/**
 * 稳定的**文本键**（日志、去重展示用）。
 *
 * 只用于"看起来一样的两条是不是同一条"，**不要**用它判断"是否同一门课" ——
 * 那要用 `sameCourse`。保留它是因为报错信息里需要一个能读的标识。
 */
export function courseKeyOf(course: Course, schedules: CourseSchedule[]): string {
  const ident: CourseIdentity = identityOf(course, schedules);
  return ident.name + '\u0001' + ident.teacher + '\u0001' + ident.groups.join('|');
}

/** 一条时段能否真的在网格上出现（掩码 0 = 每周都不上 = 永远不出现） */
function isVisible(s: CourseSchedule): boolean {
  return Number.isFinite(s.weekMask) && s.weekMask !== 0;
}

function scheduleKey(s: CourseSchedule): string {
  return `${s.dayOfWeek}|${s.startPeriod}|${s.endPeriod}|${s.weekMask}|${s.location}`;
}

/** 教学班并集（顺序稳定：排序后去重） */
function unionGroups(a: string[], b: string[]): string[] {
  const out: string[] = a.slice(0);
  for (const g of b) {
    if (out.indexOf(g) < 0) {
      out.push(g);
    }
  }
  out.sort();
  return out;
}

/**
 * 把"每格/每段一条"的解析结果合并成"一门课 + 多个时段"。
 *
 * 顺序保持首次出现的顺序（预览里的顺序与 PDF 阅读顺序一致，用户好核对）。
 */
export function mergeCourseItems(items: CourseWithSchedules[]): MergeOutcome {
  const groups: Group[] = [];
  const dropped: string[] = [];
  let duplicateSchedules = 0;

  for (const item of items) {
    const identity: CourseIdentity = identityOf(item.course, item.schedules);

    // 找出所有"是同一门课"的历史分组；不止一个说明这一条把两拨并成了一起
    const matched: Group[] = [];
    for (const g of groups) {
      if (sameCourse(g.identity, identity)) {
        matched.push(g);
      }
    }

    let target: Group;
    if (matched.length === 0) {
      target = {
        course: item.course,
        identity: identity,
        schedules: [],
        seen: new Map<string, boolean>(),
        hasVisible: false,
        firstLocation: item.course.location.trim(),
      };
      groups.push(target);
    } else {
      target = matched[0];
      // 把其它命中的分组并进来（A∩N、B∩N ⇒ A/B/N 是同一门课）
      for (let i = 1; i < matched.length; i++) {
        const other: Group = matched[i];
        for (const s of other.schedules) {
          const sk: string = scheduleKey(s);
          if (target.seen.has(sk)) {
            duplicateSchedules++;
            continue;
          }
          target.seen.set(sk, true);
          target.schedules.push(s);
          if (isVisible(s)) {
            target.hasVisible = true;
          }
        }
        if (target.firstLocation.length === 0) {
          target.firstLocation = other.firstLocation;
        }
        const idx: number = groups.indexOf(other);
        if (idx >= 0) {
          groups.splice(idx, 1);
        }
      }
      // 并集：下一次比较时用更全的教学班集合（合班写法能被后续行命中）
      target.identity = {
        name: target.identity.name,
        teacher: target.identity.teacher,
        groups: unionGroups(target.identity.groups, identity.groups),
      };
    }

    for (const s of item.schedules) {
      const sk: string = scheduleKey(s);
      if (target.seen.has(sk)) {
        duplicateSchedules++;
        continue;
      }
      target.seen.set(sk, true);
      target.schedules.push(s);
      if (isVisible(s)) {
        target.hasVisible = true;
      }
      if (target.firstLocation.length === 0 && s.location.trim().length > 0) {
        target.firstLocation = s.location.trim();
      }
    }
  }

  const out: CourseWithSchedules[] = [];
  for (const g of groups) {
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
