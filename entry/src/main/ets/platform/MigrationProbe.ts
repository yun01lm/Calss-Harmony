/**
 * 迁移演练（**开发期工具，只在 debug 包的开发者入口里出现**）。
 *
 * 为什么没删：设备上的应用沙箱目录不可读写，没法像桌面那样"塞一个 v1 库进去再启动"。
 * 但迁移路径恰恰是最危险的代码 —— 一旦在真机升级时写错，用户看到的是空课表或打不开。
 * 每加一条迁移，都应该在这里重演一次 v1→v2（它只碰 `calss_probe.db`，不动真实数据）。
 *
 * 做法：在同一台设备上造一个**独立的** v1 库（`calss_probe.db`），塞进旧学期 + 旧课程 + 旧作息，
 * 把版本号写成 1，然后关掉重开、走**和正式库同一份** `Rdb.ensureUpToDate()`，
 * 再逐条核对结果。全程不碰 `calss.db`，可以反复跑。
 *
 * 为什么值得进 App 而不是只在桌面上跑：这一步验的是 **relationalStore 能不能执行这些 SQL**
 * （`createTransaction` / `execute` / `PRAGMA user_version` / `INSERT ... SELECT ... WHERE NOT EXISTS`），
 * 这些恰恰是 Node 上的 `node:sqlite` 测不到的部分。
 */
import { common } from '@kit.AbilityKit';
import { Rdb } from './Rdb.ts';
import { PREF_CURRENT_TIMETABLE, V1_SCHEMA } from '../data/schema.ts';
import { type MigrationStep } from '../data/migrations.ts';
import { WeekCalculator } from '../logic/WeekCalculator.ts';

/** 一行自检结果 */
export interface ProbeLine {
  readonly label: string;
  readonly ok: boolean;
  readonly detail: string;
}

const PROBE_DB = 'calss_probe.db';
const PROBE_FRESH_DB = 'calss_probe_fresh.db';
const LEGACY_NAME = '2025 秋季';

export class MigrationProbe {
  static async run(context: common.Context): Promise<ProbeLine[]> {
    const lines: ProbeLine[] = [];
    const now: number = Date.now();
    const monday: number = WeekCalculator.mondayOfEpochDay(WeekCalculator.todayEpochDay());
    // 故意比"当周周一"早 18 周：如果迁移漏读旧学期，断言会立刻失败（而不是碰巧相等）
    const legacyStart: number = monday - 18 * WeekCalculator.DAYS_PER_WEEK;

    await MigrationProbe.reset(context, PROBE_DB, lines);
    await MigrationProbe.upgradePath(context, now, monday, legacyStart, lines);
    await MigrationProbe.reset(context, PROBE_FRESH_DB, lines);
    await MigrationProbe.freshPath(context, now, monday, lines);
    return lines;
  }

  /** 删掉演练库（不存在也继续） */
  private static async reset(context: common.Context, dbName: string, lines: ProbeLine[]): Promise<void> {
    try {
      await Rdb.destroy(context, dbName);
    } catch (e) {
      // 库本来就不存在时 deleteRdbStore 会报错，属于正常情况
    }
  }

  /** v1 → v2 */
  private static async upgradePath(
    context: common.Context,
    now: number,
    monday: number,
    legacyStart: number,
    lines: ProbeLine[]
  ): Promise<void> {
    // ---- 1) 造 v1 库
    let db: Rdb = await Rdb.open(context, PROBE_DB);

    // 先看一眼外键开关：SQLite 默认 OFF，Room 会替应用打开，relationalStore 没有这个保证。
    // 所以 store 层删数据一律**显式删**（不依赖 CASCADE），这一行只是把设备实际情况记下来。
    const fkOn: number = await db.scalarInt('PRAGMA foreign_keys');
    MigrationProbe.check(
      lines,
      '设备的外键开关状态（仅记录，不依赖它）',
      true,
      'PRAGMA foreign_keys=' + fkOn
    );
    const v1Steps: MigrationStep[] = [];
    for (const sql of V1_SCHEMA) {
      v1Steps.push({ sql: sql });
    }
    await db.runSteps(v1Steps);
    await db.exec('INSERT INTO semesters (name, startDateEpochDay, totalWeeks) VALUES (?, ?, ?)', [
      LEGACY_NAME,
      legacyStart,
      18,
    ]);
    await db.exec(
      'INSERT INTO courses (name, teacher, location, color, category, note) VALUES (?, ?, ?, 0, ?, ?)',
      ['数据结构', '李老师', '思源楼-301', '', '']
    );
    await db.exec(
      'INSERT INTO course_schedules (courseId, dayOfWeek, startPeriod, endPeriod, weekMask) ' +
        'VALUES (1, 2, 3, 4, 65535)'
    );
    await db.exec('INSERT INTO time_slots (periodIndex, label, startMinute, endMinute) VALUES (1, ?, 480, 525)', [
      '上午',
    ]);
    db.version = 1;
    MigrationProbe.check(lines, '造出 v1 库（version=1，1 门课 + 1 节作息）', db.version === 1, 'version=' + db.version);
    await db.close();

    // ---- 2) 重新打开，走正式代码路径
    db = await Rdb.open(context, PROBE_DB);
    const outcome = await db.ensureUpToDate(now, monday);
    MigrationProbe.check(lines, '识别为 v1→v2 升级', outcome.kind === 'upgrade', 'kind=' + outcome.kind);
    MigrationProbe.check(lines, '版本号升到 2', outcome.version === 2, 'version=' + outcome.version);

    // ---- 3) 逐条核对
    const semTables: number = await db.scalarInt(
      "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'semesters'"
    );
    MigrationProbe.check(lines, '旧 semesters 表已删除', semTables === 0, 'count=' + semTables);

    const tt = await db.query('SELECT id, name, startDateEpochDay, totalWeeks, isPrimary FROM timetables');
    const ttOk: boolean = tt.length === 1 && tt[0].int('id') === 1 && tt[0].text('name') === LEGACY_NAME &&
      tt[0].int('startDateEpochDay') === legacyStart && tt[0].int('totalWeeks') === 18 &&
      tt[0].int('isPrimary') === 1;
    MigrationProbe.check(
      lines,
      '旧学期搬进第 1 张课表（名字/开学日/周数/主课表）',
      ttOk,
      tt.length === 1
        ? `${tt[0].text('name')} · 开学 ${WeekCalculator.isoDate(tt[0].int('startDateEpochDay'))} · ${tt[0].int('totalWeeks')} 周`
        : '行数=' + tt.length
    );

    const courses = await db.query('SELECT id, timetableId, name FROM courses');
    const courseOk: boolean = courses.length === 1 && courses[0].int('timetableId') === 1;
    MigrationProbe.check(
      lines,
      '旧课程回填 timetableId = 1',
      courseOk,
      courses.length === 1 ? `${courses[0].text('name')} → timetableId=${courses[0].int('timetableId')}` : '行数=' + courses.length
    );

    const slots = await db.query('SELECT periodIndex, timetableId FROM time_slots');
    MigrationProbe.check(
      lines,
      '旧作息回填 timetableId = 1',
      slots.length === 1 && slots[0].int('timetableId') === 1,
      slots.length === 1 ? 'periodIndex=' + slots[0].int('periodIndex') : '行数=' + slots.length
    );

    const schedRows = await db.scalarInt('SELECT COUNT(*) FROM course_schedules');
    const schedOne = await db.scalarInt('SELECT COUNT(*) FROM course_schedules WHERE startPeriod = 3');
    MigrationProbe.check(lines, '时段没被动过（1 条，仍是第 3 节起）', schedRows === 1 && schedOne === 1,
      `rows=${schedRows} start3=${schedOne}`);

    const pref = await db.query('SELECT value FROM preferences WHERE key = ?', [PREF_CURRENT_TIMETABLE]);
    MigrationProbe.check(
      lines,
      '偏好 current_timetable = 1',
      pref.length === 1 && pref[0].text('value') === '1',
      pref.length === 1 ? pref[0].text('value') : '无此行'
    );

    const idxCount: number = await db.scalarInt(
      "SELECT COUNT(*) FROM sqlite_master WHERE type = 'index' AND name LIKE 'index_%_timetableId'"
    );
    MigrationProbe.check(lines, '3 个 timetableId 索引已建', idxCount === 3, 'count=' + idxCount);

    // ---- 4) 再打开一次：不该再做任何事（幂等）
    await db.close();
    db = await Rdb.open(context, PROBE_DB);
    const again = await db.ensureUpToDate(now, monday);
    MigrationProbe.check(lines, '再次打开是 noop（迁移只跑一次）', again.kind === 'noop' && again.stepCount === 0,
      `kind=${again.kind} steps=${again.stepCount}`);

    // 顺手证明"重启后数据还在"
    const coursesAfter = await db.scalarInt('SELECT COUNT(*) FROM courses');
    MigrationProbe.check(lines, '关库重开后数据仍在', coursesAfter === 1, 'courses=' + coursesAfter);

    await db.close();
    await MigrationProbe.reset(context, PROBE_DB, lines);
  }

  /** 全新安装 */
  private static async freshPath(
    context: common.Context,
    now: number,
    monday: number,
    lines: ProbeLine[]
  ): Promise<void> {
    let db: Rdb = await Rdb.open(context, PROBE_FRESH_DB);
    const first = await db.ensureUpToDate(now, monday);
    MigrationProbe.check(lines, '空库 → 全新安装（fresh）', first.kind === 'fresh', 'kind=' + first.kind);
    MigrationProbe.check(lines, '版本号 0 → 2', first.version === 2, 'version=' + first.version);

    const slots: number = await db.scalarInt('SELECT COUNT(*) FROM time_slots');
    MigrationProbe.check(lines, '播种 12 节默认作息', slots === 12, 'count=' + slots);

    const tt = await db.query('SELECT id, name, totalWeeks FROM timetables');
    MigrationProbe.check(lines, '播种第 1 张课表（我的课表 / 20 周）',
      tt.length === 1 && tt[0].int('id') === 1 && tt[0].int('totalWeeks') === 20,
      tt.length === 1 ? `${tt[0].text('name')} · ${tt[0].int('totalWeeks')} 周` : '行数=' + tt.length);

    // 关库重开：模拟杀进程重启
    await db.close();
    db = await Rdb.open(context, PROBE_FRESH_DB);
    const second = await db.ensureUpToDate(now, monday);
    MigrationProbe.check(lines, '重开后是 noop（不会重复播种）', second.kind === 'noop', 'kind=' + second.kind);
    const slotsAfter: number = await db.scalarInt('SELECT COUNT(*) FROM time_slots');
    MigrationProbe.check(lines, '重开后作息仍是 12 节', slotsAfter === 12, 'count=' + slotsAfter);

    await db.close();
    await MigrationProbe.reset(context, PROBE_FRESH_DB, lines);
  }

  private static check(lines: ProbeLine[], label: string, ok: boolean, detail: string): void {
    const line: ProbeLine = { label: label, ok: ok, detail: detail };
    lines.push(line);
  }
}
