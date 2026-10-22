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
 * @param legacy 旧学期（调用方先从 `semesters` 读出；没有则为 null）
 * @param nowMillis 当前时间戳（Android 用 `System.currentTimeMillis()`）
 */
export function migrateV1toV2(legacy: LegacySemester | null, nowMillis: number): MigrationStep[] {
  const name = legacy !== null ? legacy.name : '我的课表';
  const startDateEpochDay = legacy !== null ? legacy.startDateEpochDay : 0;
  const totalWeeks = legacy !== null ? legacy.totalWeeks : 20;

  const steps: MigrationStep[] = [
    // 1) 新表：课表 + 偏好
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
    {
      sql:
        'INSERT INTO timetables (id, name, startDateEpochDay, totalWeeks, isPrimary, createdAt) ' +
        'VALUES (1, ?, ?, ?, 1, ?)',
      params: [name, startDateEpochDay, totalWeeks, nowMillis],
    },

    // 3) 三张业务表加 timetableId 并回填
    { sql: 'ALTER TABLE courses ADD COLUMN timetableId INTEGER NOT NULL DEFAULT 0' },
    { sql: 'ALTER TABLE custom_events ADD COLUMN timetableId INTEGER NOT NULL DEFAULT 0' },
    { sql: 'ALTER TABLE time_slots ADD COLUMN timetableId INTEGER NOT NULL DEFAULT 0' },
    { sql: 'UPDATE courses SET timetableId = 1' },
    { sql: 'UPDATE custom_events SET timetableId = 1' },
    { sql: 'UPDATE time_slots SET timetableId = 1' },

    // 4) 索引（名字必须与 Room 生成的 index_<表>_<列> 一致）
    { sql: 'CREATE INDEX IF NOT EXISTS index_courses_timetableId ON courses (timetableId)' },
    {
      sql: 'CREATE INDEX IF NOT EXISTS index_custom_events_timetableId ' +
        'ON custom_events (timetableId)',
    },
    { sql: 'CREATE INDEX IF NOT EXISTS index_time_slots_timetableId ON time_slots (timetableId)' },

    // 5) 学期并入课表；偏好里记住当前课表
    { sql: 'DROP TABLE IF EXISTS semesters' },
    { sql: 'INSERT INTO preferences (key, value) VALUES (?, ?)', params: [PREF_CURRENT_TIMETABLE, '1'] },
  ];
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
