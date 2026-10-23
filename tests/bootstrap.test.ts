/**
 * 建库/升版决策的断言（`data/bootstrap.ts`）。
 *
 * 这里测的是**设备上真正会执行的那份步骤清单**：`platform/Rdb.ts` 只是把它丢进一个事务，
 * 所以"步骤对不对"在这层测完，"relationalStore 能不能执行"留给模拟器验。
 *
 * 覆盖四种状态（fresh / upgrade / repair / noop）+ 两种拒绝（版本过高、表结构与版本号矛盾）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import {
  DB_VERSION,
  KNOWN_TABLES,
  PREF_CURRENT_TIMETABLE,
  V1_SCHEMA,
  defaultSlots,
} from '../entry/src/main/ets/data/schema.ts';
import type { MigrationStep } from '../entry/src/main/ets/data/migrations.ts';
import { migrateV1toV2 } from '../entry/src/main/ets/data/migrations.ts';
import {
  BOOTSTRAP_FRESH,
  BOOTSTRAP_NOOP,
  BOOTSTRAP_REPAIR,
  BOOTSTRAP_UPGRADE,
  FRESH_TIMETABLE_NAME,
  FRESH_TOTAL_WEEKS,
  bootstrapPlan,
  freshInstallSteps,
  hasAllTables,
  knownTablesOnly,
  type BootstrapPlan,
} from '../entry/src/main/ets/data/bootstrap.ts';

// ---------------------------------------------------------------- 工具

function openDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  return db;
}

function runSteps(db: DatabaseSync, steps: MigrationStep[]): void {
  for (const s of steps) {
    if (s.params !== undefined) {
      db.prepare(s.sql).run(...s.params);
    } else {
      db.exec(s.sql);
    }
  }
}

function count(db: DatabaseSync, sql: string, ...params: Array<string | number>): number {
  const row = db.prepare(sql).get(...params) as Record<string, unknown> | undefined;
  if (row === undefined) {
    return 0;
  }
  const keys = Object.keys(row);
  return Number(row[keys[0]]);
}

function tablesOf(db: DatabaseSync): string[] {
  const rows = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all() as Array<Record<string, string>>;
  return rows.map((r) => String(r.name)).filter((n) => n !== 'sqlite_sequence');
}

function indexesOf(db: DatabaseSync): string[] {
  const rows = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all() as Array<Record<string, string>>;
  return rows.map((r) => String(r.name));
}

function userVersion(db: DatabaseSync): number {
  const row = db.prepare('PRAGMA user_version').get() as Record<string, number>;
  return Number(row.user_version);
}

/** 建一个 v1 库（三张业务表 + semesters），可选插入旧学期与旧数据 */
function makeV1Db(withLegacyRow: boolean): DatabaseSync {
  const db = openDb();
  for (const sql of V1_SCHEMA) {
    db.exec(sql);
  }
  if (withLegacyRow) {
    db.prepare(
      'INSERT INTO semesters (name, startDateEpochDay, totalWeeks) VALUES (?, ?, ?)'
    ).run('2025 秋季', 20321, 18);
    db.prepare(
      'INSERT INTO courses (name, teacher, location, color, category, note) VALUES (?, ?, ?, 0, ?, ?)'
    ).run('数据结构', '李老师', '思源楼-301', '', '');
    db.prepare(
      'INSERT INTO course_schedules (courseId, dayOfWeek, startPeriod, endPeriod, weekMask) ' +
        'VALUES (1, 2, 3, 4, 65535)'
    ).run();
    db.prepare(
      'INSERT INTO time_slots (periodIndex, label, startMinute, endMinute) VALUES (1, ?, 480, 525)'
    ).run('上午');
  }
  db.exec('PRAGMA user_version = 1');
  return db;
}

const NOW = 1760000000000;
const MONDAY = 20321;

function planFor(
  db: DatabaseSync,
  currentVersion: number,
  legacy: { name: string; startDateEpochDay: number; totalWeeks: number } | null
): BootstrapPlan {
  const existing: string[] = tablesOf(db).filter((t) => KNOWN_TABLES.indexOf(t) >= 0);
  return bootstrapPlan({
    currentVersion,
    existingTables: existing,
    existingColumns: columnsOf(db),
    legacy,
    nowMillis: NOW,
    defaultStartEpochDay: MONDAY,
  });
}

/** 现有列（形如 `courses.timetableId`），bootstrap 用它决定要不要 ALTER */
function columnsOf(db: DatabaseSync): string[] {
  const out: string[] = [];
  for (const table of ['courses', 'custom_events', 'time_slots']) {
    let rows: Array<Record<string, unknown>> = [];
    try {
      rows = db.prepare(`SELECT name FROM pragma_table_info('${table}')`).all() as Array<
        Record<string, unknown>
      >;
    } catch (e) {
      rows = [];
    }
    for (const r of rows) {
      out.push(table + '.' + String(r.name));
    }
  }
  return out;
}

// ---------------------------------------------------------------- fresh

test('fresh：空库 → 建 6 张表 + 播种第 1 张课表', () => {
  const db = openDb();
  const plan = planFor(db, 0, null);
  assert.equal(plan.kind, BOOTSTRAP_FRESH);
  assert.equal(plan.fromVersion, 0);
  assert.equal(plan.targetVersion, DB_VERSION);
  assert.ok(plan.steps.length > 0);

  runSteps(db, plan.steps);
  db.exec('PRAGMA user_version = 2'); // 平台层在事务提交后写版本号，这里等价模拟

  assert.deepEqual(
    tablesOf(db),
    ['course_schedules', 'courses', 'custom_events', 'preferences', 'time_slots', 'timetables']
  );
  assert.equal(userVersion(db), 2);

  const tt = db
    .prepare('SELECT id, name, startDateEpochDay, totalWeeks, isPrimary, createdAt FROM timetables')
    .all() as Array<Record<string, string | number>>;
  assert.equal(tt.length, 1);
  assert.equal(Number(tt[0].id), 1);
  assert.equal(tt[0].name, FRESH_TIMETABLE_NAME);
  assert.equal(Number(tt[0].startDateEpochDay), MONDAY);
  assert.equal(Number(tt[0].totalWeeks), FRESH_TOTAL_WEEKS);
  assert.equal(Number(tt[0].isPrimary), 1);
  assert.equal(Number(tt[0].createdAt), NOW);

  // 12 节默认作息，全部挂在第 1 张课表上
  assert.equal(count(db, 'SELECT COUNT(*) FROM time_slots'), 12);
  assert.equal(count(db, 'SELECT COUNT(*) FROM time_slots WHERE timetableId = 1'), 12);
  assert.equal(count(db, 'SELECT COUNT(DISTINCT periodIndex) FROM time_slots'), 12);

  // 上午 1-4 / 下午 5-8 / 晚上 9-12（与 Android defaultSlots() 一致）
  const label = (p: number): string =>
    String(
      (db.prepare('SELECT label FROM time_slots WHERE periodIndex = ?').get(p) as Record<string, string>)
        .label
    );
  assert.deepEqual([1, 4, 5, 8, 9, 12].map(label), ['上午', '上午', '下午', '下午', '晚上', '晚上']);
  const times = db
    .prepare('SELECT startMinute, endMinute FROM time_slots WHERE periodIndex = 1')
    .get() as Record<string, number>;
  assert.deepEqual([Number(times.startMinute), Number(times.endMinute)], [8 * 60, 8 * 60 + 45]);

  // 偏好：当前课表 = 1
  const pref = db
    .prepare('SELECT value FROM preferences WHERE key = ?')
    .get(PREF_CURRENT_TIMETABLE) as Record<string, string> | undefined;
  assert.equal(pref?.value, '1');

  // 4 个索引（Room/RDB 都按 index_<表>_<列> 命名）
  assert.deepEqual(indexesOf(db), [
    'index_course_schedules_courseId',
    'index_courses_timetableId',
    'index_custom_events_timetableId',
    'index_time_slots_timetableId',
  ]);
});

test('fresh：同一份步骤跑两遍不会重复播种（幂等守卫的意义）', () => {
  const db = openDb();
  const steps = freshInstallSteps(NOW, MONDAY);
  runSteps(db, steps);
  runSteps(db, steps);
  assert.equal(count(db, 'SELECT COUNT(*) FROM timetables'), 1);
  assert.equal(count(db, 'SELECT COUNT(*) FROM time_slots'), 12);
  assert.equal(count(db, 'SELECT COUNT(*) FROM preferences'), 1);
});

// ---------------------------------------------------------------- upgrade

test('upgrade：v1 → v2 旧数据全归第 1 张课表', () => {
  const db = makeV1Db(true);
  const legacy = { name: '2025 秋季', startDateEpochDay: 20321, totalWeeks: 18 };
  const plan = planFor(db, 1, legacy);
  assert.equal(plan.kind, BOOTSTRAP_UPGRADE);
  assert.equal(plan.fromVersion, 1);
  assert.equal(plan.targetVersion, 2);

  // 顺序约束：读旧学期之后才 DROP，加列之后才回填
  const idx = (needle: string): number => plan.steps.findIndex((s) => s.sql.indexOf(needle) >= 0);
  assert.ok(idx('INSERT INTO timetables') < idx('ALTER TABLE courses'));
  assert.ok(idx('ALTER TABLE courses') < idx('UPDATE courses SET timetableId = 1'));
  assert.ok(idx('UPDATE courses SET timetableId = 1') < idx('DROP TABLE IF EXISTS semesters'));

  runSteps(db, plan.steps);
  db.exec('PRAGMA user_version = 2');

  assert.equal(count(db, "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='semesters'"), 0);
  assert.equal(userVersion(db), 2);

  const tt = db.prepare('SELECT * FROM timetables').all() as Array<Record<string, string | number>>;
  assert.equal(tt.length, 1);
  assert.equal(Number(tt[0].id), 1);
  assert.equal(tt[0].name, '2025 秋季');
  assert.equal(Number(tt[0].startDateEpochDay), 20321);
  assert.equal(Number(tt[0].totalWeeks), 18);
  assert.equal(Number(tt[0].isPrimary), 1);

  // 旧课与旧作息都指向第 1 张课表
  assert.equal(count(db, 'SELECT COUNT(*) FROM courses'), 1);
  assert.equal(count(db, 'SELECT COUNT(*) FROM courses WHERE timetableId = 1'), 1);
  assert.equal(count(db, 'SELECT COUNT(*) FROM time_slots WHERE timetableId = 1'), 1);
  // 时段没被动过
  assert.equal(count(db, 'SELECT COUNT(*) FROM course_schedules'), 1);
  assert.equal(count(db, 'SELECT COUNT(*) FROM course_schedules WHERE startPeriod = 3'), 1);
  // 偏好记住了当前课表
  const pref = db.prepare('SELECT value FROM preferences WHERE key = ?').get(PREF_CURRENT_TIMETABLE) as
    | Record<string, string>
    | undefined;
  assert.equal(pref?.value, '1');
  // 新索引全在
  assert.deepEqual(indexesOf(db), [
    'index_course_schedules_courseId',
    'index_courses_timetableId',
    'index_custom_events_timetableId',
    'index_time_slots_timetableId',
  ]);
});

test('upgrade：没有旧学期行时兜底用「当周周一」，不是 0', () => {
  const db = makeV1Db(false);
  const plan = planFor(db, 1, null);
  runSteps(db, plan.steps);
  const tt = db.prepare('SELECT startDateEpochDay, totalWeeks, name FROM timetables').get() as Record<
    string,
    string | number
  >;
  // 传 null 给 migrateV1toV2 会写成 0（1970-01-01），bootstrap 必须替它兜底
  assert.equal(Number(tt.startDateEpochDay), MONDAY);
  assert.equal(Number(tt.totalWeeks), FRESH_TOTAL_WEEKS);
  assert.equal(tt.name, FRESH_TIMETABLE_NAME);
});

test('upgrade：迁移后的 courses 与全新安装逐列一致', () => {
  const fresh = openDb();
  runSteps(fresh, freshInstallSteps(NOW, MONDAY));
  const upgraded = makeV1Db(true);
  runSteps(upgraded, planFor(upgraded, 1, null).steps);

  const columns = (db: DatabaseSync, table: string): string[] =>
    (db.prepare(`PRAGMA table_info(${table})`).all() as Array<Record<string, string>>)
      .map((r) => `${r.name}:${r.type}:${r.notnull}:${r.dflt_value}`)
      .sort();

  // 迁移用 ALTER 加列，新列必然排在末尾 → 只比"列集合+约束"，不比顺序（Room 也只比集合）
  assert.deepEqual(columns(upgraded, 'courses'), columns(fresh, 'courses'));
  assert.deepEqual(columns(upgraded, 'custom_events'), columns(fresh, 'custom_events'));
  assert.deepEqual(columns(upgraded, 'time_slots'), columns(fresh, 'time_slots'));
  assert.deepEqual(columns(upgraded, 'timetables'), columns(fresh, 'timetables'));
  assert.deepEqual(tablesOf(upgraded), tablesOf(fresh));
  assert.deepEqual(indexesOf(upgraded), indexesOf(fresh));
});

// ---------------------------------------------------------------- noop / repair

test('noop：已经是最新版本时不产生任何步骤', () => {
  const db = openDb();
  runSteps(db, freshInstallSteps(NOW, MONDAY));
  const plan = planFor(db, DB_VERSION, null);
  assert.equal(plan.kind, BOOTSTRAP_NOOP);
  assert.deepEqual(plan.steps, []);
  assert.equal(plan.targetVersion, DB_VERSION);
});

test('repair：版本号是 0 但表已在 → 只补版本号，不重复播种', () => {
  const db = openDb();
  runSteps(db, freshInstallSteps(NOW, MONDAY));
  // 故意把版本号抹掉，模拟"事务提交了、版本号没写进去"
  db.exec('PRAGMA user_version = 0');
  const plan = planFor(db, 0, null);
  assert.equal(plan.kind, BOOTSTRAP_REPAIR);
  assert.deepEqual(plan.steps, []);
  assert.equal(count(db, 'SELECT COUNT(*) FROM timetables'), 1);
  assert.equal(count(db, 'SELECT COUNT(*) FROM time_slots'), 12);
});

test('repair：版本号是 1 但表已经是 v2 形状 → 只补版本号（不能重跑迁移）', () => {
  const db = makeV1Db(true);
  // 先真的迁一遍，再把版本号按回 1，模拟"迁移提交了、PRAGMA 没写进去"
  runSteps(db, migrateV1toV2({ name: '2025 秋季', startDateEpochDay: 20321, totalWeeks: 18 }, NOW, []));
  db.exec('PRAGMA user_version = 1');

  const plan = planFor(db, 1, { name: '2025 秋季', startDateEpochDay: 20321, totalWeeks: 18 });
  assert.equal(plan.kind, BOOTSTRAP_REPAIR);
  assert.deepEqual(plan.steps, []);
  // 关键：再来一次也不会撞 UNIQUE / duplicate column
  runSteps(db, plan.steps);
  assert.equal(count(db, 'SELECT COUNT(*) FROM timetables'), 1);
});

test('v1→v2 的步骤本身可以重跑：跑两遍结果一致，不抛错', () => {
  const db = makeV1Db(true);
  const legacy = { name: '2025 秋季', startDateEpochDay: 20321, totalWeeks: 18 };
  // 模拟"列已经加好了"的重跑：把当前列传进去（真实调用方就是这么传的）
  runSteps(db, migrateV1toV2(legacy, NOW, columnsOf(db)));
  const firstCourses = count(db, 'SELECT COUNT(*) FROM courses');
  const firstTimetables = count(db, 'SELECT COUNT(*) FROM timetables');
  const firstSlots = count(db, 'SELECT COUNT(*) FROM time_slots');

  runSteps(db, migrateV1toV2(legacy, NOW, columnsOf(db)));

  assert.equal(count(db, 'SELECT COUNT(*) FROM courses'), firstCourses);
  assert.equal(count(db, 'SELECT COUNT(*) FROM timetables'), firstTimetables);
  assert.equal(count(db, 'SELECT COUNT(*) FROM time_slots'), firstSlots);
  assert.equal(count(db, 'SELECT COUNT(*) FROM courses WHERE timetableId = 1'), firstCourses);
});

test('v1→v2 重跑不会把第 2 张课表的课搬回第 1 张（回填只碰 timetableId = 0）', () => {
  const db = makeV1Db(true);
  const legacy = { name: '2025 秋季', startDateEpochDay: 20321, totalWeeks: 18 };
  runSteps(db, migrateV1toV2(legacy, NOW, columnsOf(db)));
  db.prepare(
    'INSERT INTO timetables (name, startDateEpochDay, totalWeeks, isPrimary, createdAt) ' +
      'VALUES (?, ?, ?, 0, ?)'
  ).run('第二张', 20321, 18, NOW);
  db.prepare(
    'INSERT INTO courses (timetableId, name, teacher, location, color, category, note) ' +
      'VALUES (2, ?, ?, ?, 0, ?, ?)'
  ).run('只属于第二张的课', '', '', '', '');

  runSteps(db, migrateV1toV2(legacy, NOW, columnsOf(db)));

  assert.equal(count(db, 'SELECT COUNT(*) FROM courses WHERE timetableId = 2'), 1);
  assert.equal(count(db, 'SELECT COUNT(*) FROM courses WHERE timetableId = 1'), 1);
});

// ---------------------------------------------------------------- 拒绝

test('拒绝：版本号高于支持版本（旧应用开新库）', () => {
  const db = openDb();
  assert.throws(() => planFor(db, DB_VERSION + 1, null), /高于本应用支持的/);
});

test('拒绝：版本号 0 但只有一半的表（不猜、不删）', () => {
  const db = openDb();
  db.exec('CREATE TABLE courses (id INTEGER PRIMARY KEY)');
  assert.throws(() => planFor(db, 0, null), /无法判断该建库还是该迁移/);
});

test('拒绝：未知版本号（负数只可能是库被写坏）', () => {
  const db = openDb();
  assert.throws(() => planFor(db, -1, null), /未知的数据库版本号/);
});

// ---------------------------------------------------------------- 小工具

test('knownTablesOnly：只留认识的表，且按固定顺序', () => {
  assert.deepEqual(
    knownTablesOnly(['time_slots', 'whatever', 'courses', 'sqlite_sequence', 'semesters']),
    ['courses', 'time_slots', 'semesters']
  );
  assert.deepEqual(knownTablesOnly([]), []);
});

test('hasAllTables：缺一个就 false', () => {
  assert.equal(hasAllTables(['timetables', 'preferences'], ['timetables']), true);
  assert.equal(hasAllTables(['timetables'], ['timetables', 'preferences']), false);
  assert.equal(hasAllTables([], []), true);
});
