/**
 * 数据模型（纯数据，零平台依赖）—— 与 Android `data/db/Entities.kt` 逐字段对齐。
 *
 * 为什么不直接用查询结果的行对象：模型是**类型安全的边界**。上层（UI、导入流程）只认这些 interface，
 * 列名拼错、类型看错在编译期就暴露；而"列名 → 字段"的翻译只集中在 `ScheduleStore` 一处。
 *
 * `id = 0` 一律表示"还没入库"（与 Room 的 autoGenerate 约定一致）。
 */

/** 一张课表 = 课程 + 自定义安排 + 作息 + 学期设置（开学日/总周数） */
export interface Timetable {
  readonly id: number;
  readonly name: string;
  /** 第 1 周周一（epochDay），周次计算的唯一基准 */
  readonly startDateEpochDay: number;
  readonly totalWeeks: number;
  readonly isPrimary: boolean;
  readonly createdAt: number;
}

/** 作息：第几节 → 起止钟点。每张课表各有一套 */
export interface TimeSlot {
  readonly id: number;
  readonly timetableId: number;
  readonly periodIndex: number;
  /** 上午 / 下午 / 晚上（可为空） */
  readonly label: string;
  /** 一天内分钟数，8:00 = 480 */
  readonly startMinute: number;
  readonly endMinute: number;
}

/** 课程本体：只存课程自身信息，时间在 CourseSchedule 里 */
export interface Course {
  readonly id: number;
  readonly timetableId: number;
  readonly name: string;
  readonly teacher: string;
  readonly location: string;
  /** 0 = 按课程名自动配色 */
  readonly color: number;
  /** 理论/实验/上机/实践/其他 */
  readonly category: string;
  readonly note: string;
}

/** 一门课的一次上课时间；一门课可有多条 */
export interface CourseSchedule {
  readonly id: number;
  readonly courseId: number;
  /** 1 = 周一 … 7 = 周日 */
  readonly dayOfWeek: number;
  readonly startPeriod: number;
  readonly endPeriod: number;
  /** 周次位掩码（bit0 = 第 1 周）；与库交界处用 `maskFromDb` / `maskToDb` 转换 */
  readonly weekMask: number;
}

/** 自定义安排（自习/健身/约会等） */
export interface CustomEvent {
  readonly id: number;
  readonly timetableId: number;
  readonly title: string;
  readonly dayOfWeek: number;
  /** 节次定位（优先） */
  readonly startPeriod: number | null;
  readonly endPeriod: number | null;
  /** 自由钟点定位（一天内分钟数）；M2 起用于跨节次安排 */
  readonly startMinute: number | null;
  readonly endMinute: number | null;
  readonly weekMask: number;
  readonly color: number;
  readonly note: string;
}

/** 一张课表的全部数据（一次读齐，切表时整体换掉） */
export interface Snapshot {
  readonly timetable: Timetable | null;
  readonly slots: TimeSlot[];
  readonly courses: Course[];
  readonly schedules: CourseSchedule[];
  readonly events: CustomEvent[];
}

/** 课程 + 它的全部上课时段（导入、保存都用这个组合） */
export interface CourseWithSchedules {
  readonly course: Course;
  readonly schedules: CourseSchedule[];
}

/** 合并导入的结果 */
export interface MergeResult {
  readonly added: number;
  readonly updated: number;
}

/**
 * 周次掩码的安全位数。
 *
 * 为什么写在这里：SQLite 的 INTEGER 是 64 位，Android 用 `Long` 存得下 64 周；
 * 但鸿蒙 `relationalStore` 的 `getLong()` 返回 **JS number（双精度）**，超过 2^53 就丢精度。
 * 本应用的总周数被限制在 1..30（与 Android 一致），实际操作不会碰到这个边界；
 * 这里加一道**显式拒绝**，是为了让"超出范围"变成能看见的错，而不是安静地存进一个错的掩码。
 */
export const MAX_SAFE_WEEK = 53;

/** 库里的 INTEGER → 逻辑层的 bigint 掩码 */
export function maskFromDb(raw: number): bigint {
  return BigInt(Math.trunc(raw));
}

/** 逻辑层的 bigint 掩码 → 库里的 INTEGER；越界直接抛错 */
export function maskToDb(bits: bigint): number {
  if (bits < BigInt(0)) {
    throw new Error('周次掩码不能为负数：' + bits.toString());
  }
  const limit: bigint = BigInt(1) << BigInt(MAX_SAFE_WEEK);
  if (bits >= limit) {
    throw new Error(
      '周次掩码超出可安全存储的 ' + MAX_SAFE_WEEK + ' 位（' + bits.toString() +
        '）。学期周数上限 30，出现这种情况说明数据有问题'
    );
  }
  return Number(bits);
}

/**
 * 校验一个"已经在 number 里"的掩码（模型字段的类型就是 number）。
 * 写库前调用：非安全整数或负数直接抛错，不让它悄悄变成别的周次。
 */
export function assertSafeMask(mask: number): number {
  if (!Number.isSafeInteger(mask) || mask < 0) {
    throw new Error(
      '周次掩码不合法（' + mask + '）：必须是 0 到 2^' + MAX_SAFE_WEEK + ' 之间的整数'
    );
  }
  return mask;
}

/** 新建课表时的默认学期周数（与 Android `createTimetable` 一致） */export const MIN_TOTAL_WEEKS = 1;
export const MAX_TOTAL_WEEKS = 30;

/** 课表名 / 周数规范化：空白名保留原名，周数夹到 1..30 */
export function clampTotalWeeks(weeks: number): number {
  if (Number.isNaN(weeks) || weeks < MIN_TOTAL_WEEKS) {
    return MIN_TOTAL_WEEKS;
  }
  if (weeks > MAX_TOTAL_WEEKS) {
    return MAX_TOTAL_WEEKS;
  }
  return Math.trunc(weeks);
}
