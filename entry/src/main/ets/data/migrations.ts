/**
 * 数据库迁移步骤（纯 SQL 序列，零平台依赖）。
 *
 * v1 → v2：引入"多课表"。策略与 Android 版一模一样：**旧数据全部归到第 1 张课表**
 * （沿用原来的学期设置），老用户升级后看到的东西和升级前完全一样。
 *
 * 为什么把迁移写成"一串带回退语义的 SQL 步骤"而不是一段平台代码：
 * 可以在 Node 上用真 SQLite 完整跑一遍（含建 v1 库 → 插旧数据 → 迁移 → 逐列比对 schema），
 * 不需要设备、不需要 DevEco。平台层只需把这些步骤包在一个事务里执行。
 *
 * 三个必须守住的顺序/格式约束（Android 侧踩过）：
 * 1. **读旧学期必须在 DROP TABLE semesters 之前**；
 * 2. 三个 `ALTER TABLE ... ADD COLUMN ... NOT NULL DEFAULT 0`（SQLite 加列必须给默认值）；
 * 3. 索引名必须是 `index_<表>_<列>`，否则 Room（Android）会认为 schema 不匹配。
 */
import { PREF_CURRENT_TIMETABLE, defaultSlots, type SlotSeed } from './schema.ts';

/** 一步迁移：可以是纯 SQL，也可以带参数 */
export interface MigrationStep {
  readonly sql: string;
  readonly params?: Array<string | number>;
}

/** 从 v1 的 semesters 表读到的旧学期信息 */
export interface LegacySemester {
  readonly name: string;
  readonly startDateEpochDay: number;
  readonly totalWeeks: number;
}

/**
 * 生成 v1 → v2 的迁移步骤。
 *
 * **整套步骤必须可以安全重跑**：`PRAGMA user_version` 是独立于事务的一步，
 * 存在"迁移事务已提交、版本号没写进去"的窗口（`platform/Rdb.ts` 的注释里写了这件事）。
 * 重跑时如果 `INSERT timetables id=1` 或 `ALTER ... ADD COLUMN` 又执行一遍，
 * 会直接抛约束错误 —— 而且每次启动都抛，用户永远打不开课表。
 *
 * @param legacy 旧学期（调用方先从 `semesters` 读出；没有则为 null）
 * @param nowMillis 当前时间戳（Android 用 `System.currentTimeMillis()`）
 * @param existingColumns 现有列，形如 `['courses.timetableId', ...]`；
 *        缺失的 ALTER 才生成。不传则视为"全都要加"（首次迁移）
 */
export function migrateV1toV2(
  legacy: LegacySemester | null,
  nowMillis: number,
  existingColumns: string[] = []
): MigrationStep[] {
  const name = legacy !== null ? legacy.name : '我的课表';
  const startDateEpochDay = legacy !== null ? legacy.startDateEpochDay : 0;
  const totalWeeks = legacy !== null ? legacy.totalWeeks : 20;

  const steps: MigrationStep[] = [
    // 1) 新表：课表 + 偏好（IF NOT EXISTS：重跑安全）
    {
      sql:
        'CREATE TABLE IF NOT EXISTS timetables (' +
        'id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, ' +
        'name TEXT NOT NULL, startDateEpochDay INTEGER NOT NULL, ' +
        'totalWeeks INTEGER NOT NULL, isPrimary INTEGER NOT NULL, createdAt INTEGER NOT NULL)',
    },
    {
      sql: 'CREATE TABLE IF NOT EXISTS preferences (' +
        'key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(key))',
    },

    // 2) 旧数据归到第 1 张课表（**显式给 id = 1**，下面三个 ALTER 的回填都指向它）
    //    WHERE NOT EXISTS：重跑时不再插第二条 id=1（第一次就是这么炸的）
    {
      sql:
        'INSERT INTO timetables (id, name, startDateEpochDay, totalWeeks, isPrimary, createdAt) ' +
        'SELECT 1, ?, ?, ?, 1, ? WHERE NOT EXISTS (SELECT 1 FROM timetables WHERE id = 1)',
      params: [name, startDateEpochDay, totalWeeks, nowMillis],
    },
  ];

  // 3) 三张业务表加 timetableId 并回填。列已在就不 ALTER（SQLite 没有 ADD COLUMN IF NOT EXISTS）
  appendAddColumn(steps, existingColumns, 'courses', 'timetableId');
  appendAddColumn(steps, existingColumns, 'custom_events', 'timetableId');
  appendAddColumn(steps, existingColumns, 'time_slots', 'timetableId');
  // 只回填还是 0 的行：**不能无条件 SET = 1**，否则重跑会把用户后来建的第 2、3 张课表的课都搬回第 1 张
  steps.push({ sql: 'UPDATE courses SET timetableId = 1 WHERE timetableId = 0' });
  steps.push({ sql: 'UPDATE custom_events SET timetableId = 1 WHERE timetableId = 0' });
  steps.push({ sql: 'UPDATE time_slots SET timetableId = 1 WHERE timetableId = 0' });

  // 4) 索引（名字必须与 Room 生成的 index_<表>_<列> 一致）
  steps.push({ sql: 'CREATE INDEX IF NOT EXISTS index_courses_timetableId ON courses (timetableId)' });
  steps.push({
    sql: 'CREATE INDEX IF NOT EXISTS index_custom_events_timetableId ' +
      'ON custom_events (timetableId)',
  });
  steps.push({ sql: 'CREATE INDEX IF NOT EXISTS index_time_slots_timetableId ON time_slots (timetableId)' });

  // 5) 学期并入课表；偏好里记住当前课表（OR IGNORE：重跑不覆盖用户已经切过的当前课表）
  steps.push({ sql: 'DROP TABLE IF EXISTS semesters' });
  steps.push({
    sql: 'INSERT OR IGNORE INTO preferences (key, value) VALUES (?, ?)',
    params: [PREF_CURRENT_TIMETABLE, '1'],
  });
  return steps;
}

/** 列存在就不加；返回是否真的加了一条（调用方目前不需要，但留着省得再写一份判断） */
function appendAddColumn(
  steps: MigrationStep[],
  existingColumns: string[],
  table: string,
  column: string,
  ddl: string = 'INTEGER NOT NULL DEFAULT 0'
): boolean {
  if (existingColumns.indexOf(table + '.' + column) >= 0) {
    return false;
  }
  steps.push({
    sql: 'ALTER TABLE ' + table + ' ADD COLUMN ' + column + ' ' + ddl,
  });
  return true;
}

/**
 * v2 → v3：给 `course_schedules` 加 `location`（每次上课自己的教室）。
 *
 * 为什么回填成"课程的教室"而不是留空：v2 里教室只存在课程上，
 * 直接留空会让升级后的旧数据全部没有地点；回填成原值，用户看到的和升级前一模一样。
 * 回填条件是 `location = ''`，所以**重跑安全**（与 v1→v2 同一条要求）。
 */
export function migrateV2toV3(existingColumns: string[] = []): MigrationStep[] {
  const steps: MigrationStep[] = [];
  appendAddColumn(steps, existingColumns, 'course_schedules', 'location', "TEXT NOT NULL DEFAULT ''");
  steps.push({
    sql:
      "UPDATE course_schedules SET location = COALESCE(" +
      "(SELECT c.location FROM courses c WHERE c.id = course_schedules.courseId), '') " +
      "WHERE location = ''",
  });
  return steps;
}

/**
 * 新建课表时写入的默认作息（12 节）。
 * 与 Android `SeedCallback` 一致：全新安装的第 1 张课表也带这套作息。
 *
 * 每条 INSERT 都带 `WHERE NOT EXISTS` 幂等守卫：同一张课表的同一节不会被播种两次。
 * 这不是洁癖 —— `data/bootstrap.ts` 有一条"建库事务已提交、版本号没写进去"的恢复路径，
 * 它依赖**播种步骤可以安全重跑**。
 */
export function seedSlotRows(timetableId: number): Array<MigrationStep> {
  const slots: SlotSeed[] = defaultSlots();
  const steps: MigrationStep[] = [];
  for (const s of slots) {
    steps.push({
      sql:
        'INSERT INTO time_slots (timetableId, periodIndex, label, startMinute, endMinute) ' +
        'SELECT ?, ?, ?, ?, ? ' +
        'WHERE NOT EXISTS (SELECT 1 FROM time_slots WHERE timetableId = ? AND periodIndex = ?)',
      params: [
        timetableId,
        s.periodIndex,
        s.label,
        s.startMinute,
        s.endMinute,
        timetableId,
        s.periodIndex,
      ],
    });
  }
  return steps;
}
