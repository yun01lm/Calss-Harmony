/**
 * 建库 / 升版的**决策 + 步骤清单**（纯数据，零平台依赖）。
 *
 * 为什么单独一层：`platform/Rdb.ts` 只该做"把 SQL 交给 relationalStore 执行"，
 * 而"该建库还是该迁移、先做什么后做什么"是业务判断，可以在 Node 上用真 SQLite 完整验证。
 * 于是同一份步骤清单，测试里跑一遍、设备上跑一遍，不会出现"测试和线上不是同一套"
 * 这种最典型的假验证。
 *
 * ## 打开库时可能遇到的四种状态
 *
 * | 版本号 | 表结构 | 处理 |
 * |-------|--------|------|
 * | 0 | 空 | `fresh`：建 6 张表 + 播种第 1 张课表 / 12 节作息 / 当前课表偏好 |
 * | 1 | v1（三张业务表 + semesters） | `upgrade`：v1 → v2（旧数据归到第 1 张课表） |
 * | 2 | v2 | `noop` |
 * | 0 | 已经是 v2 | `repair`：只补版本号（上次建完库没来得及记版本） |
 *
 * 第四行是刻意加的**恢复路径**：`store.version = 2` 不是事务的一部分（它是单独的
 * `PRAGMA user_version`），理论上存在"事务已提交、版本号没写进去"的窗口。
 * 有这一步，那种情况下不会重复播种（`fresh` 的每条 INSERT 都带 `WHERE NOT EXISTS` 幂等守卫）
 * 也不会重复 ALTER（那会直接报错）。
 *
 * 版本号 **高于** 当前应用支持的版本（用户装回了旧版本）时**直接抛错**：
 * 旧代码去操作新结构的库，是数据损坏的经典来源，宁可打不开也不要写坏。
 */
import { DB_VERSION, PREF_CURRENT_TIMETABLE, V3_SCHEMA, KNOWN_TABLES } from './schema.ts';
import {
  migrateV1toV2,
  migrateV2toV3,
  seedSlotRows,
  type LegacySemester,
  type MigrationStep,
} from './migrations.ts';

/** 没有任何可操作步骤（库已经是最新） */
export const BOOTSTRAP_NOOP = 'noop';
/** 全新安装 */
export const BOOTSTRAP_FRESH = 'fresh';
/** v1 → v2 */
export const BOOTSTRAP_UPGRADE = 'upgrade';
/** 表已在、版本号没写进去 → 只补版本号 */
export const BOOTSTRAP_REPAIR = 'repair';

/** 首次安装那张课表的名字（与 Android `SeedCallback` 一致） */
export const FRESH_TIMETABLE_NAME = '我的课表';
/** 首次安装的默认周数（与 Android 一致） */
export const FRESH_TOTAL_WEEKS = 20;

export interface BootstrapInput {
  /** `store.version` 读到的当前版本号（全新库是 0） */
  readonly currentVersion: number;
  /** `sqlite_master` 里查到的、属于本应用的现有表名 */
  readonly existingTables: string[];
  /**
   * 现有列，形如 `courses.timetableId`。
   * v1→v2 的 ALTER 按它决定要不要加 —— 迁移**可以重跑**是硬要求（见 `migrations.ts` 的注释）。
   */
  readonly existingColumns?: string[];
  /** v1 的 semester 行（调用方在**建表之前**读出来；没有则为 null） */
  readonly legacy: LegacySemester | null;
  /** 当前时间戳，写进 `timetables.createdAt` */
  readonly nowMillis: number;
  /** 当周周一（epochDay），旧学期缺失时用它兜底 */
  readonly defaultStartEpochDay: number;
}

export interface BootstrapPlan {
  /** 见上方 BOOTSTRAP_* 常量 */
  readonly kind: string;
  readonly fromVersion: number;
  readonly targetVersion: number;
  /** 需要在**一个事务**里依次执行的步骤；空数组表示不用写库 */
  readonly steps: MigrationStep[];
}

/**
 * 全新安装的步骤：建表 + 播种。
 *
 * 每条 INSERT 都带 `WHERE NOT EXISTS`，因此**重复执行是安全的** —— 这不是洁癖：
 * 上面说的"版本号丢失"恢复路径依赖它，测试里也会真的跑两遍来证明幂等。
 */
export function freshInstallSteps(nowMillis: number, startEpochDay: number): MigrationStep[] {
  const steps: MigrationStep[] = [];
  for (const sql of V3_SCHEMA) {
    steps.push({ sql: sql });
  }
  // 显式给 id = 1：下面 12 条作息的 timetableId 要指向它（空表上 AUTOINCREMENT 本来也会给 1，
  // 写出来是为了不依赖这个隐含事实）
  steps.push({
    sql:
      'INSERT INTO timetables (id, name, startDateEpochDay, totalWeeks, isPrimary, createdAt) ' +
      'SELECT 1, ?, ?, ?, 1, ? WHERE NOT EXISTS (SELECT 1 FROM timetables)',
    params: [FRESH_TIMETABLE_NAME, startEpochDay, FRESH_TOTAL_WEEKS, nowMillis],
  });
  for (const slot of seedSlotRows(1)) {
    steps.push(slot);
  }
  steps.push({
    sql: 'INSERT OR REPLACE INTO preferences (key, value) VALUES (?, ?)',
    params: [PREF_CURRENT_TIMETABLE, '1'],
  });
  return steps;
}

/** 判断 existingTables 是否包含全部 want */
export function hasAllTables(existingTables: string[], want: string[]): boolean {
  for (const name of want) {
    if (existingTables.indexOf(name) < 0) {
      return false;
    }
  }
  return true;
}

/** `existingColumns` 里是否包含全部 `want`（形如 `courses.timetableId`） */
export function hasAllColumns(existingColumns: string[], want: string[]): boolean {
  for (const c of want) {
    if (existingColumns.indexOf(c) < 0) {
      return false;
    }
  }
  return true;
}

/**
 * 决定本次打开库要做什么。
 *
 * @throws 版本号高于支持版本 / 版本号与表结构互相矛盾时抛错（错误信息写给用户看，
 *         会原样显示在页面上，方便截图取证）
 */
export function bootstrapPlan(input: BootstrapInput): BootstrapPlan {
  const current = input.currentVersion;

  if (current > DB_VERSION) {
    throw new Error(
      '数据库版本是 ' + current + '，高于本应用支持的 ' + DB_VERSION +
        '（可能装过更新的版本）。为免写坏数据，已停止打开。'
    );
  }

  if (current === DB_VERSION) {
    return {
      kind: BOOTSTRAP_NOOP,
      fromVersion: current,
      targetVersion: DB_VERSION,
      steps: [],
    };
  }

  const cols: string[] = input.existingColumns !== undefined ? input.existingColumns : [];
  /** v3 那一列在不在（判断"迁移跑了但版本号没写进去"用） */
  const hasScheduleLocation: boolean = cols.indexOf('course_schedules.location') >= 0;

  if (current === 2) {
    if (hasScheduleLocation) {
      return {
        kind: BOOTSTRAP_REPAIR,
        fromVersion: current,
        targetVersion: DB_VERSION,
        steps: [],
      };
    }
    return {
      kind: BOOTSTRAP_UPGRADE,
      fromVersion: current,
      targetVersion: DB_VERSION,
      steps: migrateV2toV3(cols),
    };
  }

  if (current === 1) {
    // "迁移事务提交了、版本号没写进去"：表已经是 v2 形状 → 别再跑一遍 v1→v2，
    // 只需要补上 v3 那一列（连它也在 = 纯 repair）。
    // 之前这里**只有 current === 0 有恢复路径**，v1 这种情况会重跑迁移，而旧实现不可重跑
    // （`INSERT timetables id=1` + 三条 ALTER），于是每次启动都撞 UNIQUE 约束 —— 库没坏但永远打不开。
    if (
      hasAllTables(input.existingTables, ['timetables', 'preferences']) &&
      hasAllColumns(cols, ['courses.timetableId', 'custom_events.timetableId', 'time_slots.timetableId'])
    ) {
      return {
        kind: hasScheduleLocation ? BOOTSTRAP_REPAIR : BOOTSTRAP_UPGRADE,
        fromVersion: current,
        targetVersion: DB_VERSION,
        steps: hasScheduleLocation ? [] : migrateV2toV3(cols),
      };
    }
    // 旧学期缺失时不能传 null：`migrateV1toV2(null, ...)` 会把 startDateEpochDay 写成 0
    //（= 1970-01-01），而 Android 那边兜底是"当周周一"。这里补齐，两边行为一致。
    const legacy: LegacySemester = input.legacy !== null
      ? input.legacy
      : {
        name: FRESH_TIMETABLE_NAME,
        startDateEpochDay: input.defaultStartEpochDay,
        totalWeeks: FRESH_TOTAL_WEEKS,
      };
    // v1 → v2 → v3 一次跑完（两步都是幂等的）
    const steps: MigrationStep[] = migrateV1toV2(legacy, input.nowMillis, cols);
    for (const step of migrateV2toV3(cols)) {
      steps.push(step);
    }
    return {
      kind: BOOTSTRAP_UPGRADE,
      fromVersion: current,
      targetVersion: DB_VERSION,
      steps: steps,
    };
  }

  if (current === 0) {
    if (input.existingTables.length === 0) {
      return {
        kind: BOOTSTRAP_FRESH,
        fromVersion: 0,
        targetVersion: DB_VERSION,
        steps: freshInstallSteps(input.nowMillis, input.defaultStartEpochDay),
      };
    }
    if (hasAllTables(input.existingTables, ['timetables', 'preferences'])) {
      // 建库事务已提交，只是版本号没写进去 → 别再建表、别再播种
      return {
        kind: BOOTSTRAP_REPAIR,
        fromVersion: 0,
        targetVersion: DB_VERSION,
        steps: [],
      };
    }
    throw new Error(
      '数据库版本号是 0，但已存在表 [' + input.existingTables.join(', ') +
        '] 却缺少 timetables/preferences。无法判断该建库还是该迁移，已停止打开（不猜、不删）。'
    );
  }

  throw new Error('未知的数据库版本号 ' + current + '（支持 0/1/' + DB_VERSION + '）');
}

/** 把 existingTables 过滤成"本应用认识的表"，结果按 KNOWN_TABLES 顺序 */
export function knownTablesOnly(existingTables: string[]): string[] {
  const out: string[] = [];
  for (const name of KNOWN_TABLES) {
    if (existingTables.indexOf(name) >= 0) {
      out.push(name);
    }
  }
  return out;
}
