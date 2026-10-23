/**
 * 数据层断言：用 **Node 内置 SQLite**（`node:sqlite`）跑真 SQL。
 *
 * 为什么要这样测：`relationalStore` 没有编译期 ORM，SQL 写错只会在运行时炸；
 * 等上模拟器才发现代价太高。这里把 schema、迁移、导入语义、级联删除全部在真 SQLite 上验一遍，
 * 平台层（`platform/Rdb.ts`）只负责把这些同样的 SQL 交给 relationalStore。
 *
 * 断言来源：Android 侧 `tools/verify_data_layer.py`（52 条）+ 迁移后 schema 逐列比对。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import {
  DB_VERSION,
  PREF_CURRENT_TIMETABLE,
  V1_SCHEMA,
  V2_SCHEMA,
  V3_SCHEMA,
  V4_SCHEMA,
  defaultSlots,
} from '../entry/src/main/ets/data/schema.ts';
import {
  migrateV1toV2,
  migrateV2toV3,
  migrateV3toV4,
  seedSlotRows,
  type MigrationStep,
} from '../entry/src/main/ets/data/migrations.ts';
import { pickStartupTimetable, type TimetableChoice } from '../entry/src/main/ets/data/startupRule.ts';

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

function execAll(db: DatabaseSync, sqls: string[]): void {
  for (const s of sqls) {
    db.exec(s);
  }
}

function count(db: DatabaseSync, sql: string, ...params: Array<string | number>): number {
  const row = db.prepare(sql).get(...params) as Record<string, number> | undefined;
  if (row === undefined) {
    return 0;
  }
  const keys = Object.keys(row);
  return Number(row[keys[0]]);
}

/** 插入一门课 + 一个时段，返回课程 id（**v2 表**，带 timetableId） */
function insertCourse(
  db: DatabaseSync,
  timetableId: number,
  name: string,
  teacher: string,
  location: string,
  dayOfWeek: number,
  startPeriod: number,
  endPeriod: number,
  weekMask: number
): number {
  const info = db
    .prepare(
      'INSERT INTO courses (timetableId, name, teacher, location, color, category, note) ' +
        "VALUES (?, ?, ?, ?, 0, '', '')"
    )
    .run(timetableId, name, teacher, location);
  const courseId = Number(info.lastInsertRowid);
  db.prepare(
    'INSERT INTO course_schedules (courseId, dayOfWeek, startPeriod, endPeriod, weekMask) ' +
      'VALUES (?, ?, ?, ?, ?)'
  ).run(courseId, dayOfWeek, startPeriod, endPeriod, weekMask);
  return courseId;
}

/** 插入一门课 + 时段（**v1 表**，没有 timetableId 列） */
function insertLegacyCourse(
  db: DatabaseSync,
  name: string,
  teacher: string,
  location: string,
  dayOfWeek: number,
  startPeriod: number,
  endPeriod: number,
  weekMask: number
): number {
  const info = db
    .prepare(
      'INSERT INTO courses (name, teacher, location, color, category, note) ' +
        "VALUES (?, ?, ?, 0, '', '')"
    )
    .run(name, teacher, location);
  const courseId = Number(info.lastInsertRowid);
  db.prepare(
    'INSERT INTO course_schedules (courseId, dayOfWeek, startPeriod, endPeriod, weekMask) ' +
      'VALUES (?, ?, ?, ?, ?)'
  ).run(courseId, dayOfWeek, startPeriod, endPeriod, weekMask);
  return courseId;
}

/** 全新安装：建库 + 默认课表 + 默认作息 + 当前课表偏好 */
function freshInstall(db: DatabaseSync, nowMillis: number, startDateEpochDay: number): void {
  execAll(db, V4_SCHEMA);
  db.prepare(
    'INSERT INTO timetables (name, startDateEpochDay, totalWeeks, isPrimary, createdAt) ' +
      "VALUES ('我的课表', ?, 20, 1, ?)"
  ).run(startDateEpochDay, nowMillis);
  runSteps(db, seedSlotRows(1));
  db.prepare('INSERT INTO preferences (key, value) VALUES (?, ?)').run(
    PREF_CURRENT_TIMETABLE,
    '1'
  );
}

/**
 * 某张表的列定义（用于"迁移后 schema 与全新安装一致"的逐列比对）。
 *
 * **排序后再比**：`ALTER TABLE ADD COLUMN` 只能把新列加到末尾，所以迁移后的列顺序
 * 与全新安装不同（`timetableId` 在最后）。Room 校验 schema 时同样只比较"列集合 + 每列属性"、
 * 不比较顺序，这里保持一致口径。
 */
/** 现有列（形如 `course_schedules.location`），决定迁移要不要 ALTER */
function columnsOf(db: DatabaseSync): string[] {
  const out: string[] = [];
  for (const table of ['courses', 'course_schedules', 'custom_events', 'time_slots']) {
    const rows = db
      .prepare(`SELECT name FROM pragma_table_info('${table}')`)
      .all() as Array<Record<string, unknown>>;
    for (const r of rows) {
      out.push(table + '.' + String(r.name));
    }
  }
  return out;
}

function tableInfo(db: DatabaseSync, table: string): string[] {
  const rows = db.prepare('PRAGMA table_info(' + table + ')').all() as Array<Record<string, unknown>>;
  return rows
    .map((r) => `${r.name}|${r.type}|${r.notnull}|${r.dflt_value === null ? '' : r.dflt_value}|${r.pk}`)
    .sort();
}

function indexNames(db: DatabaseSync, table: string): string[] {
  const rows = db.prepare('PRAGMA index_list(' + table + ')').all() as Array<Record<string, unknown>>;
  return rows.map((r) => String(r.name)).sort();
}

// ---------------------------------------------------------------- A. 全新安装
test('A1 全新安装：6 张表齐全，版本号 4', () => {
  const db = openDb();
  freshInstall(db, 1000, 20000);
  const tables = (db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all() as Array<Record<string, unknown>>).map((r) => String(r.name));
  assert.deepEqual(tables, [
    'course_schedules',
    'courses',
    'custom_events',
    'preferences',
    'time_slots',
    'timetables',
  ]);
  assert.equal(DB_VERSION, 4);
  db.close();
});

test('A2 全新安装：默认 12 节作息 + 主课表 + 当前课表偏好', () => {
  const db = openDb();
  freshInstall(db, 1000, 20000);
  assert.equal(count(db, 'SELECT COUNT(*) AS c FROM time_slots'), 12);
  assert.equal(count(db, 'SELECT COUNT(*) AS c FROM timetables'), 1);
  assert.equal(count(db, 'SELECT COUNT(*) AS c FROM timetables WHERE isPrimary = 1'), 1);
  const pref = db
    .prepare('SELECT value FROM preferences WHERE key = ?')
    .get(PREF_CURRENT_TIMETABLE) as Record<string, string> | undefined;
  assert.equal(pref?.value, '1');

  // 作息与 Android 的 defaultSlots 完全一致
  const slots = db
    .prepare('SELECT periodIndex, label, startMinute, endMinute FROM time_slots ORDER BY periodIndex')
    .all() as Array<Record<string, unknown>>;
  assert.equal(slots.length, defaultSlots().length);
  for (let i = 0; i < slots.length; i++) {
    const expected = defaultSlots()[i];
    assert.equal(slots[i].periodIndex, expected.periodIndex);
    assert.equal(slots[i].label, expected.label);
    assert.equal(slots[i].startMinute, expected.startMinute, `第 ${expected.periodIndex} 节开始时间`);
    assert.equal(slots[i].endMinute, expected.endMinute);
  }
  assert.equal(slots[0].startMinute, 480, '第 1 节 8:00');
  assert.equal(slots[11].endMinute, 1340, '第 12 节 22:20');
  db.close();
});

test('A3 全新安装：索引齐全（4 个）', () => {
  const db = openDb();
  freshInstall(db, 1000, 20000);
  assert.deepEqual(indexNames(db, 'courses'), ['index_courses_timetableId']);
  assert.deepEqual(indexNames(db, 'custom_events'), ['index_custom_events_timetableId']);
  assert.deepEqual(indexNames(db, 'time_slots'), ['index_time_slots_timetableId']);
  assert.deepEqual(indexNames(db, 'course_schedules'), ['index_course_schedules_courseId']);
  db.close();
});

test('A4 外键级联：删课自动删它的时段', () => {
  const db = openDb();
  freshInstall(db, 1000, 20000);
  const id = insertCourse(db, 1, '高等数学', '张老师', '思源楼-301', 2, 3, 4, 65535);
  assert.equal(count(db, 'SELECT COUNT(*) AS c FROM course_schedules'), 1);
  db.prepare('DELETE FROM courses WHERE id = ?').run(id);
  assert.equal(count(db, 'SELECT COUNT(*) AS c FROM course_schedules'), 0, '时段应被级联删除');
  db.close();
});

test('A5 外键真的开了（插一条指向不存在课程的时段应失败）', () => {
  const db = openDb();
  freshInstall(db, 1000, 20000);
  assert.throws(() => {
    db.prepare(
      'INSERT INTO course_schedules (courseId, dayOfWeek, startPeriod, endPeriod, weekMask) ' +
        'VALUES (999999, 1, 1, 2, 255)'
    ).run();
  }, '外键约束应拦住孤儿时段');
  db.close();
});

// ---------------------------------------------------------------- B. v1 → v2 迁移
function buildV1WithData(db: DatabaseSync): void {
  execAll(db, V1_SCHEMA);
  db.prepare(
    'INSERT INTO semesters (name, startDateEpochDay, totalWeeks) VALUES (?, ?, ?)'
  ).run('2026 秋', 19999, 18);
  // 旧课程的时段（v1 表没有 timetableId）
  const c1 = insertLegacyCourse(db, '旧课一', '王老师', '思源楼-401', 1, 1, 2, 65535);
  const c2 = insertLegacyCourse(db, '旧课二', '李老师', '知行楼-C207', 3, 5, 6, 255);
  assert.ok(c1 > 0 && c2 > 0);
  db.prepare(
    'INSERT INTO custom_events (title, dayOfWeek, startPeriod, endPeriod, weekMask, color, note) ' +
      "VALUES ('健身', 3, 9, 10, 65535, 0, '')"
  ).run();
  db.prepare(
    'INSERT INTO time_slots (periodIndex, label, startMinute, endMinute) VALUES (?, ?, ?, ?)'
  ).run(1, '上午', 480, 525);
  db.prepare(
    'INSERT INTO time_slots (periodIndex, label, startMinute, endMinute) VALUES (?, ?, ?, ?)'
  ).run(2, '上午', 530, 575);
}

test('B1 迁移：旧学期变成第 1 张课表（名字/开学日/周数全部保留）', () => {
  const db = openDb();
  buildV1WithData(db);
  // 调换顺序验证：旧数据必须还在（不能在迁移里丢）
  const beforeCourses = count(db, 'SELECT COUNT(*) AS c FROM courses');
  const beforeSlots = count(db, 'SELECT COUNT(*) AS c FROM time_slots');
  const beforeEvents = count(db, 'SELECT COUNT(*) AS c FROM custom_events');

  runSteps(db, migrateV1toV2({ name: '2026 秋', startDateEpochDay: 19999, totalWeeks: 18 }, 5000));

  const tt = db
    .prepare('SELECT id, name, startDateEpochDay, totalWeeks, isPrimary FROM timetables')
    .all() as Array<Record<string, unknown>>;
  assert.equal(tt.length, 1);
  assert.equal(tt[0].id, 1);
  assert.equal(tt[0].name, '2026 秋');
  assert.equal(tt[0].startDateEpochDay, 19999);
  assert.equal(tt[0].totalWeeks, 18);
  assert.equal(tt[0].isPrimary, 1);

  // 一条都没少
  assert.equal(count(db, 'SELECT COUNT(*) AS c FROM courses'), beforeCourses);
  assert.equal(count(db, 'SELECT COUNT(*) AS c FROM time_slots'), beforeSlots);
  assert.equal(count(db, 'SELECT COUNT(*) AS c FROM custom_events'), beforeEvents);
  db.close();
});

test('B2 迁移：三张业务表全部回填 timetableId = 1，且 semesters 已被删除', () => {
  const db = openDb();
  buildV1WithData(db);
  runSteps(db, migrateV1toV2({ name: '2026 秋', startDateEpochDay: 19999, totalWeeks: 18 }, 5000));

  for (const table of ['courses', 'custom_events', 'time_slots']) {
    assert.equal(
      count(db, 'SELECT COUNT(*) AS c FROM ' + table + ' WHERE timetableId <> 1'),
      0,
      table + ' 应全部归到第 1 张课表'
    );
  }
  const semesters = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='semesters'")
    .all();
  assert.equal(semesters.length, 0, 'v1 的 semesters 表必须被删除');

  const pref = db
    .prepare('SELECT value FROM preferences WHERE key = ?')
    .get(PREF_CURRENT_TIMETABLE) as Record<string, string> | undefined;
  assert.equal(pref?.value, '1', '迁移后应记住当前课表');
  db.close();
});

test('B3 迁移后 schema 与全新安装**逐列一致**（类型/非空/默认值/主键）', () => {
  const migrated = openDb();
  buildV1WithData(migrated);
  runSteps(migrated, migrateV1toV2({ name: '2026 秋', startDateEpochDay: 19999, totalWeeks: 18 }, 5000));
  // v2→v3 也要跑：否则'迁移后的库'比'全新安装'少一列，这个用例就失去意义了
  runSteps(migrated, migrateV2toV3());
  runSteps(migrated, migrateV3toV4());

  const fresh = openDb();
  freshInstall(fresh, 1000, 20000);

  for (const table of ['timetables', 'preferences', 'courses', 'course_schedules', 'custom_events', 'time_slots']) {
    assert.deepEqual(tableInfo(migrated, table), tableInfo(fresh, table), table + ' 的列定义应一致');
    assert.deepEqual(indexNames(migrated, table), indexNames(fresh, table), table + ' 的索引应一致');
  }
  migrated.close();
  fresh.close();
});

test('B4 迁移：没有旧学期时按兜底处理（默认名 + 20 周）', () => {
  const db = openDb();
  execAll(db, V1_SCHEMA);
  db.prepare(
    'INSERT INTO courses (name, teacher, location, color, category, note) VALUES (?, ?, ?, 0, ?, ?)'
  ).run('无学期旧课', '王老师', '思源楼-101', '', '');
  runSteps(db, migrateV1toV2(null, 5000));
  const tt = db.prepare('SELECT name, totalWeeks, startDateEpochDay FROM timetables').get() as Record<string, unknown>;
  assert.equal(tt.name, '我的课表');
  assert.equal(tt.totalWeeks, 20);
  assert.equal(count(db, 'SELECT COUNT(*) AS c FROM courses WHERE timetableId = 1'), 1);
  db.close();
});

test('B5 迁移：旧索引/timetableId 加列后仍可正常插入与查询', () => {
  const db = openDb();
  buildV1WithData(db);
  runSteps(db, migrateV1toV2({ name: '2026 秋', startDateEpochDay: 19999, totalWeeks: 18 }, 5000));
  // 迁移后新插入的数据（带显式 timetableId）
  const id = insertCourse(db, 1, '新加的课', '赵老师', '实验楼-B503', 4, 7, 8, 255);
  assert.ok(id > 0);
  assert.equal(count(db, 'SELECT COUNT(*) AS c FROM courses WHERE timetableId = 1'), 3);
  db.close();
});

// ---------------------------------------------------------------- C. 多课表隔离与导入语义
function setupTwoTimetables(db: DatabaseSync): void {
  freshInstall(db, 1000, 20000);
  db.prepare(
    'INSERT INTO timetables (name, startDateEpochDay, totalWeeks, isPrimary, createdAt) ' +
      "VALUES ('辅修课表', 20100, 16, 0, 2000)"
  ).run();
  runSteps(db, seedSlotRows(2));
}

test('C1 多课表：课程/安排/作息按 timetableId 隔离', () => {
  const db = openDb();
  setupTwoTimetables(db);
  insertCourse(db, 1, '主课表课程', '张老师', '思源楼-301', 2, 3, 4, 255);
  insertCourse(db, 2, '辅修课程', '李老师', '知行楼-C207', 6, 1, 2, 255);
  assert.equal(count(db, 'SELECT COUNT(*) AS c FROM courses WHERE timetableId = 1'), 1);
  assert.equal(count(db, 'SELECT COUNT(*) AS c FROM courses WHERE timetableId = 2'), 1);
  assert.equal(count(db, 'SELECT COUNT(*) AS c FROM time_slots WHERE timetableId = 1'), 12);
  assert.equal(count(db, 'SELECT COUNT(*) AS c FROM time_slots WHERE timetableId = 2'), 12);
  db.close();
});

test('C2 覆盖导入：清空当前课表课程后写入，其他课表与自定义安排不受影响', () => {
  const db = openDb();
  setupTwoTimetables(db);
  // 主课表已有 3 门 + 1 个安排；辅修课表 1 门
  insertCourse(db, 1, '旧一', '张老师', '思源楼-301', 2, 3, 4, 255);
  insertCourse(db, 1, '旧二', '张老师', '思源楼-302', 2, 5, 6, 255);
  insertCourse(db, 1, '旧三', '王老师', '知行楼-C207', 4, 1, 2, 255);
  insertCourse(db, 2, '辅修', '李老师', '知行楼-C207', 6, 1, 2, 255);
  db.prepare(
    "INSERT INTO custom_events (timetableId, title, dayOfWeek, startPeriod, endPeriod, weekMask, color, note) " +
      "VALUES (1, '健身', 3, 9, 10, 65535, 0, '')"
  ).run();

  // 覆盖：删掉主课表的课程 → 写 2 门新课（事务内完成）
  db.exec('BEGIN');
  db.prepare('DELETE FROM courses WHERE timetableId = 1').run();
  insertCourse(db, 1, '新一', '赵老师', '实验楼-B503', 1, 1, 2, 255);
  insertCourse(db, 1, '新二', '赵老师', '实验楼-B504', 3, 3, 4, 255);
  db.exec('COMMIT');

  assert.equal(count(db, 'SELECT COUNT(*) AS c FROM courses WHERE timetableId = 1'), 2);
  assert.equal(count(db, 'SELECT COUNT(*) AS c FROM courses WHERE name LIKE ?', '旧%'), 0, '旧课应清空');
  assert.equal(
    count(db, 'SELECT COUNT(*) AS c FROM course_schedules WHERE courseId IN (SELECT id FROM courses WHERE name LIKE ?)', '旧%'),
    0,
    '旧课的时段应被级联删除'
  );
  assert.equal(count(db, 'SELECT COUNT(*) AS c FROM custom_events WHERE timetableId = 1'), 1, '自定义安排保留');
  assert.equal(count(db, 'SELECT COUNT(*) AS c FROM courses WHERE timetableId = 2'), 1, '别的课表不受影响');
  assert.equal(count(db, 'SELECT COUNT(*) AS c FROM time_slots WHERE timetableId = 2'), 12);
  db.close();
});

test('C3 合并导入：同名课程更新上课时段，其余新增', () => {
  const db = openDb();
  setupTwoTimetables(db);
  const existingId = insertCourse(db, 1, '软件工程', '张老师', '思源楼-301', 2, 3, 4, 255);
  // 合并：同名（名称+教师+地点）→ 换掉它的时段；再加一门新书
  db.exec('BEGIN');
  db.prepare('DELETE FROM course_schedules WHERE courseId = ?').run(existingId);
  db.prepare(
    'INSERT INTO course_schedules (courseId, dayOfWeek, startPeriod, endPeriod, weekMask) ' +
      'VALUES (?, 5, 9, 10, 65535)'
  ).run(existingId);
  insertCourse(db, 1, '全新的课', '赵老师', '实验楼-B503', 4, 7, 8, 255);
  db.exec('COMMIT');

  assert.equal(count(db, 'SELECT COUNT(*) AS c FROM courses WHERE timetableId = 1'), 2);
  const rows = db
    .prepare('SELECT dayOfWeek, startPeriod, endPeriod, weekMask FROM course_schedules WHERE courseId = ?')
    .all(existingId) as Array<Record<string, number>>;
  assert.equal(rows.length, 1, '同名课程只保留一条时段');
  assert.equal(rows[0].dayOfWeek, 5);
  assert.equal(rows[0].startPeriod, 9);
  db.close();
});

test('C4 新建课表导入：原课表零改动，作息被复制过去', () => {
  const db = openDb();
  setupTwoTimetables(db);
  insertCourse(db, 1, '原有的课', '张老师', '思源楼-301', 2, 3, 4, 255);
  const beforeCourses = count(db, 'SELECT COUNT(*) AS c FROM courses WHERE timetableId = 1');
  const beforeSlots = count(db, 'SELECT COUNT(*) AS c FROM time_slots WHERE timetableId = 1');

  // 新建第 3 张课表 + 复制作息 + 导入课程
  db.prepare(
    'INSERT INTO timetables (name, startDateEpochDay, totalWeeks, isPrimary, createdAt) ' +
      "VALUES ('导入的课表', 20000, 20, 0, 3000)"
  ).run();
  const newId = Number(
    (db.prepare('SELECT id FROM timetables WHERE name = ?').get('导入的课表') as Record<string, number>).id
  );
  db.prepare(
    'INSERT INTO time_slots (timetableId, periodIndex, label, startMinute, endMinute) ' +
      'SELECT ?, periodIndex, label, startMinute, endMinute FROM time_slots WHERE timetableId = 1'
  ).run(newId);
  insertCourse(db, newId, '导入的课', '赵老师', '实验楼-B503', 1, 1, 2, 255);

  assert.equal(count(db, 'SELECT COUNT(*) AS c FROM courses WHERE timetableId = 1'), beforeCourses, '原课表课程没变');
  assert.equal(count(db, 'SELECT COUNT(*) AS c FROM time_slots WHERE timetableId = 1'), beforeSlots, '原课表作息没变');
  assert.equal(count(db, 'SELECT COUNT(*) AS c FROM courses WHERE timetableId = ?', newId), 1);
  assert.equal(count(db, 'SELECT COUNT(*) AS c FROM time_slots WHERE timetableId = ?', newId), 12);
  db.close();
});

test('C5 删课表：显式清理该表的课程/安排/作息（三张表都没有外键，必须手动删）', () => {
  const db = openDb();
  setupTwoTimetables(db);
  insertCourse(db, 2, '辅修课', '李老师', '知行楼-C207', 6, 1, 2, 255);
  db.prepare(
    "INSERT INTO custom_events (timetableId, title, dayOfWeek, startPeriod, endPeriod, weekMask, color, note) " +
      "VALUES (2, '社团', 5, 3, 4, 65535, 0, '')"
  ).run();

  db.exec('BEGIN');
  db.prepare('DELETE FROM courses WHERE timetableId = ?').run(2);
  db.prepare('DELETE FROM custom_events WHERE timetableId = ?').run(2);
  db.prepare('DELETE FROM time_slots WHERE timetableId = ?').run(2);
  db.prepare('DELETE FROM timetables WHERE id = ?').run(2);
  db.exec('COMMIT');

  assert.equal(count(db, 'SELECT COUNT(*) AS c FROM timetables'), 1);
  assert.equal(count(db, 'SELECT COUNT(*) AS c FROM courses WHERE timetableId = 2'), 0);
  assert.equal(count(db, 'SELECT COUNT(*) AS c FROM course_schedules'), 0, '时段随课程级联删除');
  assert.equal(count(db, 'SELECT COUNT(*) AS c FROM custom_events WHERE timetableId = 2'), 0);
  assert.equal(count(db, 'SELECT COUNT(*) AS c FROM time_slots WHERE timetableId = 2'), 0);
  db.close();
});

// ---------------------------------------------------------------- D. 启动选表规则
test('D1 启动选表：开关打开且有主课表 → 主课表', () => {
  const all: TimetableChoice[] = [
    { id: 1, isPrimary: true, createdAt: 100 },
    { id: 2, isPrimary: false, createdAt: 200 },
  ];
  assert.equal(pickStartupTimetable(all, 2, true), 1);
});

test('D2 启动选表：开关关闭 → 上次用的那张', () => {
  const all: TimetableChoice[] = [
    { id: 1, isPrimary: true, createdAt: 100 },
    { id: 2, isPrimary: false, createdAt: 200 },
  ];
  assert.equal(pickStartupTimetable(all, 2, false), 2);
});

test('D3 启动选表：开关打开但没有主课表 → 仍用上次那张（不硬塞第一张）', () => {
  const all: TimetableChoice[] = [
    { id: 1, isPrimary: false, createdAt: 100 },
    { id: 2, isPrimary: false, createdAt: 200 },
  ];
  assert.equal(pickStartupTimetable(all, 2, true), 2);
});

test('D4 启动选表：开关打开、无主课表、无上次 → 第一张兜底', () => {
  const all: TimetableChoice[] = [
    { id: 2, isPrimary: false, createdAt: 200 },
    { id: 1, isPrimary: false, createdAt: 100 },
  ];
  assert.equal(pickStartupTimetable(all, null, true), 1, '按创建时间取最早那张');
});

test('D5 启动选表：上次那张已被删除 → 退回主课表 → 再退回第一张', () => {
  const withPrimary: TimetableChoice[] = [
    { id: 1, isPrimary: false, createdAt: 100 },
    { id: 3, isPrimary: true, createdAt: 300 },
  ];
  assert.equal(pickStartupTimetable(withPrimary, 99, false), 3, '上次那张没了就回主课表');
  const noPrimary: TimetableChoice[] = [
    { id: 1, isPrimary: false, createdAt: 100 },
    { id: 3, isPrimary: false, createdAt: 300 },
  ];
  assert.equal(pickStartupTimetable(noPrimary, 99, false), 1);
});

test('D6 启动选表：一张都没有 → null（调用方补建默认课表）', () => {
  assert.equal(pickStartupTimetable([], 7, true), null);
});

test('B6 迁移 v2→v3：给每条时段加 location，并从课程的教室回填', () => {
  const db = openDb();
  // 造一个 v2 库（没有 location 列）
  execAll(db, V2_SCHEMA);
  db.prepare(
    'INSERT INTO timetables (id, name, startDateEpochDay, totalWeeks, isPrimary, createdAt) ' +
      'VALUES (1, ?, ?, ?, 1, ?)'
  ).run('我的课表', 20000, 20, 1000);
  db.prepare(
    'INSERT INTO courses (id, timetableId, name, teacher, location, color, category, note) ' +
      'VALUES (1, 1, ?, ?, ?, 0, ?, ?)'
  ).run('数字电子技术基础', '孙红霞', '思源楼-301', '', '');
  db.prepare(
    'INSERT INTO course_schedules (courseId, dayOfWeek, startPeriod, endPeriod, weekMask) ' +
      'VALUES (1, 1, 9, 10, 65535)'
  ).run();
  db.exec('PRAGMA user_version = 2');

  runSteps(db, migrateV2toV3(columnsOf(db)));
  db.exec('PRAGMA user_version = 3');

  const version = (db.prepare('PRAGMA user_version').get() as Record<string, unknown>).user_version;
  assert.equal(Number(version), 3);
  const row = db
    .prepare('SELECT location FROM course_schedules WHERE courseId = 1')
    .get() as Record<string, string> | undefined;
  assert.equal(row?.location, '思源楼-301', '旧数据的教室要回填到时段上');
  // 重跑安全
  runSteps(db, migrateV2toV3(columnsOf(db)));
  assert.equal(count(db, 'SELECT COUNT(*) AS c FROM course_schedules'), 1);
  db.close();
});

test('B7 迁移 v2→v3：与全新安装的 schema 仍然逐列一致', () => {
  const db = openDb();
  execAll(db, V2_SCHEMA);
  db.exec('PRAGMA user_version = 2');
  runSteps(db, migrateV2toV3(columnsOf(db)));
  runSteps(db, migrateV3toV4(columnsOf(db)));

  const fresh = openDb();
  freshInstall(fresh, 1000, 20000);
  assert.deepEqual(tableInfo(db, 'course_schedules'), tableInfo(fresh, 'course_schedules'));
  assert.deepEqual(indexNames(db, 'course_schedules'), indexNames(fresh, 'course_schedules'));
  db.close();
  fresh.close();
});

test('B8 迁移 v3→v4：加 classGroup 列，可重跑，与全新安装一致', () => {
  const db = openDb();
  execAll(db, V4_SCHEMA);
  // 模拟 v3 库：把 classGroup 列去掉（用 v2 schema 建再补 location）
  const v3 = openDb();
  execAll(v3, V2_SCHEMA);
  runSteps(v3, migrateV2toV3(columnsOf(v3)));
  v3.exec('PRAGMA user_version = 3');

  const before = tableInfo(v3, 'course_schedules').length;
  runSteps(v3, migrateV3toV4(columnsOf(v3)));
  const after = tableInfo(v3, 'course_schedules').length;
  assert.equal(after, before + 1, '只加一列');
  assert.equal(
    tableInfo(v3, 'course_schedules').some((c) => c.indexOf('classGroup|TEXT|1|\'\'|0') >= 0),
    true
  );

  const fresh = openDb();
  freshInstall(fresh, 1000, 20000);
  assert.deepEqual(tableInfo(v3, 'course_schedules'), tableInfo(fresh, 'course_schedules'));

  // 重跑安全（列已在就不再加）
  runSteps(v3, migrateV3toV4(columnsOf(v3)));
  assert.equal(tableInfo(v3, 'course_schedules').length, after);
  db.close();
  v3.close();
  fresh.close();
});
