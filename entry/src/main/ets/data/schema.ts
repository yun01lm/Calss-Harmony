/**
 * 数据库 schema（纯 SQL 文本，零平台依赖）。
 *
 * 字段与 Android 版 `data/db/Entities.kt` **逐列对齐** —— 这样两边解析出来的课表可以互相迁移，
 * 也让"迁移后的库与全新安装的库结构一致"这条断言有意义。
 *
 * 为什么 SQL 单独放一层、而不是直接写在 `platform/Rdb.ts` 里：
 * 1. 这些字符串可以在 Node 上用**真 SQLite**（`node:sqlite`）跑，迁移与级联行为不需要设备就能验证；
 * 2. 平台层只负责"把 SQL 交给 relationalStore 执行"，出错时能确定是 SQL 问题还是 API 问题。
 *
 * 三个容易被 Room 校验卡住的点（Android 侧踩过，照抄结论）：
 * - SQLite 加列必须 `NOT NULL DEFAULT 0`，实体上也要声明 `defaultValue = "0"`；
 * - 建表语句必须与实体推导出的 schema 完全一致（类型、NOT NULL、AUTOINCREMENT）；
 * - 索引名必须是 `index_<表>_<列>`。
 */
export const DB_NAME = 'calss.db';

/** 当前 schema 版本（v2 = 多课表；v3 = 每次上课各有自己的教室） */
export const DB_VERSION = 3;

/** v1 里那三张业务表**没有** timetableId（迁移要补） */
export const V1_SCHEMA: string[] = [
  'CREATE TABLE IF NOT EXISTS `courses` (' +
    '`id` INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, ' +
    '`name` TEXT NOT NULL, `teacher` TEXT NOT NULL, `location` TEXT NOT NULL, ' +
    '`color` INTEGER NOT NULL, `category` TEXT NOT NULL, `note` TEXT NOT NULL)',
  'CREATE TABLE IF NOT EXISTS `course_schedules` (' +
    '`id` INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, `courseId` INTEGER NOT NULL, ' +
    '`dayOfWeek` INTEGER NOT NULL, `startPeriod` INTEGER NOT NULL, ' +
    '`endPeriod` INTEGER NOT NULL, `weekMask` INTEGER NOT NULL, ' +
    'FOREIGN KEY(`courseId`) REFERENCES `courses`(`id`) ON UPDATE NO ACTION ON DELETE CASCADE)',
  'CREATE INDEX IF NOT EXISTS `index_course_schedules_courseId` ' +
    'ON `course_schedules` (`courseId`)',
  'CREATE TABLE IF NOT EXISTS `custom_events` (' +
    '`id` INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, `title` TEXT NOT NULL, ' +
    '`dayOfWeek` INTEGER NOT NULL, `startPeriod` INTEGER, `endPeriod` INTEGER, ' +
    '`startMinute` INTEGER, `endMinute` INTEGER, `weekMask` INTEGER NOT NULL, ' +
    '`color` INTEGER NOT NULL, `note` TEXT NOT NULL)',
  'CREATE TABLE IF NOT EXISTS `time_slots` (' +
    '`id` INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, `periodIndex` INTEGER NOT NULL, ' +
    '`label` TEXT NOT NULL, `startMinute` INTEGER NOT NULL, `endMinute` INTEGER NOT NULL)',
  // v1 的全局学期表（v2 里已并入 timetables）
  'CREATE TABLE IF NOT EXISTS `semesters` (' +
    '`id` INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, `name` TEXT NOT NULL, ' +
    '`startDateEpochDay` INTEGER NOT NULL, `totalWeeks` INTEGER NOT NULL)',
];

/** v2（全新安装）：6 张表 + 4 个索引 */
export const V2_SCHEMA: string[] = [
  'CREATE TABLE IF NOT EXISTS `timetables` (' +
    '`id` INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, `name` TEXT NOT NULL, ' +
    '`startDateEpochDay` INTEGER NOT NULL, `totalWeeks` INTEGER NOT NULL, ' +
    '`isPrimary` INTEGER NOT NULL, `createdAt` INTEGER NOT NULL)',
  'CREATE TABLE IF NOT EXISTS `preferences` (' +
    '`key` TEXT NOT NULL, `value` TEXT NOT NULL, PRIMARY KEY(`key`))',
  'CREATE TABLE IF NOT EXISTS `courses` (' +
    '`id` INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, ' +
    '`timetableId` INTEGER NOT NULL DEFAULT 0, ' +
    '`name` TEXT NOT NULL, `teacher` TEXT NOT NULL, `location` TEXT NOT NULL, ' +
    '`color` INTEGER NOT NULL, `category` TEXT NOT NULL, `note` TEXT NOT NULL)',
  'CREATE INDEX IF NOT EXISTS `index_courses_timetableId` ON `courses` (`timetableId`)',
  'CREATE TABLE IF NOT EXISTS `course_schedules` (' +
    '`id` INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, `courseId` INTEGER NOT NULL, ' +
    '`dayOfWeek` INTEGER NOT NULL, `startPeriod` INTEGER NOT NULL, ' +
    '`endPeriod` INTEGER NOT NULL, `weekMask` INTEGER NOT NULL, ' +
    'FOREIGN KEY(`courseId`) REFERENCES `courses`(`id`) ON UPDATE NO ACTION ON DELETE CASCADE)',
  'CREATE INDEX IF NOT EXISTS `index_course_schedules_courseId` ' +
    'ON `course_schedules` (`courseId`)',
  'CREATE TABLE IF NOT EXISTS `custom_events` (' +
    '`id` INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, ' +
    '`timetableId` INTEGER NOT NULL DEFAULT 0, `title` TEXT NOT NULL, ' +
    '`dayOfWeek` INTEGER NOT NULL, `startPeriod` INTEGER, `endPeriod` INTEGER, ' +
    '`startMinute` INTEGER, `endMinute` INTEGER, `weekMask` INTEGER NOT NULL, ' +
    '`color` INTEGER NOT NULL, `note` TEXT NOT NULL)',
  'CREATE INDEX IF NOT EXISTS `index_custom_events_timetableId` ' +
    'ON `custom_events` (`timetableId`)',
  'CREATE TABLE IF NOT EXISTS `time_slots` (' +
    '`id` INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, ' +
    '`timetableId` INTEGER NOT NULL DEFAULT 0, `periodIndex` INTEGER NOT NULL, ' +
    '`label` TEXT NOT NULL, `startMinute` INTEGER NOT NULL, `endMinute` INTEGER NOT NULL)',
  'CREATE INDEX IF NOT EXISTS `index_time_slots_timetableId` ON `time_slots` (`timetableId`)',
];

/**
 * v3（全新安装）：在 v2 基础上给 `course_schedules` 加 `location`。
 *
 * 为什么要给**每次上课**单独记教室：一门课一周上两次、两次在不同楼是常态
 * （真实课表里"数字电子技术基础"周一在 301、周五在 107）。教室原本挂在课程上，
 * 于是"按名称+教师+教室"归并时这种课会被拆成两门 —— 改一门只改一半。
 * 现在教室跟着时段走，课程上的 `location` 退化成"默认教室"（时段没填时用它）。
 */
const COURSE_SCHEDULES_V2 =
  'CREATE TABLE IF NOT EXISTS `course_schedules` (' +
  '`id` INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, `courseId` INTEGER NOT NULL, ' +
  '`dayOfWeek` INTEGER NOT NULL, `startPeriod` INTEGER NOT NULL, ' +
  '`endPeriod` INTEGER NOT NULL, `weekMask` INTEGER NOT NULL, ' +
  'FOREIGN KEY(`courseId`) REFERENCES `courses`(`id`) ON UPDATE NO ACTION ON DELETE CASCADE)';

const COURSE_SCHEDULES_V3 =
  'CREATE TABLE IF NOT EXISTS `course_schedules` (' +
  '`id` INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, `courseId` INTEGER NOT NULL, ' +
  '`dayOfWeek` INTEGER NOT NULL, `startPeriod` INTEGER NOT NULL, ' +
  '`endPeriod` INTEGER NOT NULL, `weekMask` INTEGER NOT NULL, ' +
  '`location` TEXT NOT NULL DEFAULT \'\', ' +
  'FOREIGN KEY(`courseId`) REFERENCES `courses`(`id`) ON UPDATE NO ACTION ON DELETE CASCADE)';

/**
 * v3 的全新安装 schema = v2 把 `course_schedules` 换成带 `location` 的那条。
 *
 * 用"替换那一条"而不是整份复制：两份 SQL 一字不差地抄两遍，
 * 早晚会有人只改了其中一份（这正是迁移类 bug 的经典来源）。
 */
export const V3_SCHEMA: string[] = V2_SCHEMA.map((sql: string): string => {
  return sql === COURSE_SCHEDULES_V2 ? COURSE_SCHEDULES_V3 : sql;
});

/**
 * 本应用认识的全部表名（v1 + v2 + v3 合并）。
 *
 * 用途：打开库时先看 `sqlite_master` 里到底有哪些表，用来判断"这个库现在处于什么状态"。
 * 这一步是**防静默损坏**的关键 —— 见 `data/bootstrap.ts` 里对"版本号为 0 但表已存在"的处理。
 */
export const KNOWN_TABLES: string[] = [
  'timetables',
  'preferences',
  'courses',
  'course_schedules',
  'custom_events',
  'time_slots',
  'semesters',
];

/** 偏好键（与 Android 的 PrefKeys 一致） */
export const PREF_CURRENT_TIMETABLE = 'current_timetable_id';
export const PREF_OPEN_PRIMARY_ON_LAUNCH = 'open_primary_on_launch';

/** 一门课的作息（第几节 → 起止分钟） */
export interface SlotSeed {
  readonly periodIndex: number;
  readonly label: string;
  readonly startMinute: number;
  readonly endMinute: number;
}

/**
 * 大学常见 12 节作息（与 Android `defaultSlots()` 逐条一致）。
 * 新建课表时默认套用；用户可在作息页整体修改，或从别的课表复制。
 */
export function defaultSlots(): SlotSeed[] {
  const raw: Array<[number, number, number]> = [
    // [开始分钟, 结束分钟, 序号]
    [8 * 60 + 0, 8 * 60 + 45, 1],
    [8 * 60 + 50, 9 * 60 + 35, 2],
    [9 * 60 + 55, 10 * 60 + 40, 3],
    [10 * 60 + 45, 11 * 60 + 30, 4],
    [14 * 60 + 0, 14 * 60 + 45, 5],
    [14 * 60 + 50, 15 * 60 + 35, 6],
    [15 * 60 + 55, 16 * 60 + 40, 7],
    [16 * 60 + 45, 17 * 60 + 30, 8],
    [19 * 60 + 0, 19 * 60 + 45, 9],
    [19 * 60 + 50, 20 * 60 + 35, 10],
    [20 * 60 + 45, 21 * 60 + 30, 11],
    [21 * 60 + 35, 22 * 60 + 20, 12],
  ];
  const out: SlotSeed[] = [];
  for (const item of raw) {
    const period = item[2];
    let label = '晚上';
    if (period >= 1 && period <= 4) {
      label = '上午';
    } else if (period >= 5 && period <= 8) {
      label = '下午';
    }
    out.push({
      periodIndex: period,
      label,
      startMinute: item[0],
      endMinute: item[1],
    });
  }
  return out;
}
