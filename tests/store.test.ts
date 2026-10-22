/**
 * 业务语义层断言：`data/ScheduleStore.ts` 跑在**真 SQLite** 上（`node:sqlite`，通过 `SqlRunner` 接口）。
 *
 * 这里测的不是"SQL 能不能执行"（那是 data/sql 的事），而是**会丢数据的那些判断**：
 * 启动打开哪张表、覆盖导入留不留旧课、合并导入换不换时段、删课表有没有留下孤儿时段。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { PREF_CURRENT_TIMETABLE, PREF_OPEN_PRIMARY_ON_LAUNCH, V2_SCHEMA } from '../entry/src/main/ets/data/schema.ts';
import { ScheduleStore } from '../entry/src/main/ets/data/ScheduleStore.ts';
import {
  assertSafeMask,
  maskToDb,
  type Course,
  type CourseSchedule,
  type CourseWithSchedules,
  type CustomEvent,
} from '../entry/src/main/ets/data/models.ts';
import { WeekCalculator } from '../entry/src/main/ets/logic/WeekCalculator.ts';
import { SqliteRunner, type SqliteRunnerOptions } from './helpers/sqliteRunner.ts';

// 2026-10-21T12:00Z：无论本机在哪个时区，落在的都是 10-19 那一周
const NOW = Date.UTC(2026, 9, 21, 12, 0, 0);
const MONDAY = WeekCalculator.epochDayOf(2026, 10, 19);
const WEEKS_1_TO_16 = (BigInt(1) << BigInt(16)) - BigInt(1);

interface Fixture {
  readonly store: ScheduleStore;
  readonly runner: SqliteRunner;
}

function makeStore(options: SqliteRunnerOptions = {}): Fixture {
  const runner = SqliteRunner.open(options);
  for (const sql of V2_SCHEMA) {
    runner.db.exec(sql);
  }
  return { store: new ScheduleStore(runner), runner };
}

function course(name: string, patch: Partial<Course> = {}): Course {
  return {
    id: 0,
    timetableId: 0,
    name: name,
    teacher: '',
    location: '',
    color: 0,
    category: '',
    note: '',
    ...patch,
  };
}

function sched(dayOfWeek: number, startPeriod: number, endPeriod: number, weeks: bigint): CourseSchedule {
  return {
    id: 0,
    courseId: 0,
    dayOfWeek: dayOfWeek,
    startPeriod: startPeriod,
    endPeriod: endPeriod,
    weekMask: maskToDb(weeks),
  };
}

function event(title: string): CustomEvent {
  return {
    id: 0,
    timetableId: 0,
    title: title,
    dayOfWeek: 6,
    startPeriod: null,
    endPeriod: null,
    startMinute: 19 * 60,
    endMinute: 21 * 60,
    weekMask: maskToDb(WEEKS_1_TO_16),
    color: 0,
    note: '',
  };
}

function bundle(c: Course, schedules: CourseSchedule[]): CourseWithSchedules {
  return { course: c, schedules: schedules };
}

// ---------------------------------------------------------------- 启动

test('空库：首次启动现场建一张「我的课表」+ 12 节作息', async () => {
  const { store } = makeStore();
  const id = await store.ensureCurrentTimetable(NOW);
  assert.equal(id, 1);

  const t = await store.timetableById(id);
  assert.ok(t !== null);
  assert.equal(t.name, '我的课表');
  assert.equal(t.totalWeeks, 20);
  assert.equal(t.isPrimary, true);
  // 开学日对齐到当周周一，否则周次边界与星期列会错位
  assert.equal(t.startDateEpochDay, MONDAY);
  assert.equal(await store.slotCount(), 12);
});

test('ensureCurrentTimetable 幂等：连调三次只有一张课表', async () => {
  const { store, runner } = makeStore();
  const a = await store.ensureCurrentTimetable(NOW);
  const b = await store.ensureCurrentTimetable(NOW);
  const c = await store.ensureCurrentTimetable(NOW);
  assert.deepEqual([a, b, c], [1, 1, 1]);
  assert.equal(await runner.scalarInt('SELECT COUNT(*) FROM timetables'), 1);
});

test('启动规则：默认打开上次用的那张', async () => {
  const { store, runner } = makeStore();
  await store.ensureCurrentTimetable(NOW);
  const second = await store.createTimetable('辅修', MONDAY, 18, null, NOW);
  await store.createTimetable('考研', MONDAY, 20, null, NOW);
  await store.switchTo(second);

  // 新实例 = 新进程；只留数据库
  const restarted = new ScheduleStore(runner);
  assert.equal(await restarted.ensureCurrentTimetable(NOW), second);
});

test('启动规则：勾了「总是打开主课表」且确实有主课表 → 用主课表', async () => {
  const { store, runner } = makeStore();
  await store.ensureCurrentTimetable(NOW);
  const second = await store.createTimetable('辅修', MONDAY, 18, null, NOW);
  await store.switchTo(second);
  await store.setOpenPrimaryOnLaunch(true);

  const restarted = new ScheduleStore(runner);
  assert.equal(await restarted.ensureCurrentTimetable(NOW), 1);
});

test('启动规则：记住的课表已被删 → 回退主课表，而不是报错', async () => {
  const { store, runner } = makeStore();
  await store.ensureCurrentTimetable(NOW);
  await store.switchTo(999);
  const restarted = new ScheduleStore(runner);
  assert.equal(await restarted.ensureCurrentTimetable(NOW), 1);
});

test('switchTo 会写下偏好，另一个实例能读回同一张', async () => {
  const { store, runner } = makeStore();
  await store.ensureCurrentTimetable(NOW);
  const second = await store.createTimetable('辅修', MONDAY, 18, null, NOW);
  await store.switchTo(second);

  const rows = await runner.query('SELECT value FROM preferences WHERE key = ?', [PREF_CURRENT_TIMETABLE]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].text('value'), String(second));
  assert.equal(await new ScheduleStore(runner).ensureCurrentTimetable(NOW), second);
});

// ---------------------------------------------------------------- 课表增删改

test('createTimetable：开学日对齐周一、周数夹到 1..30、非首张不是主课表', async () => {
  const { store } = makeStore();
  await store.ensureCurrentTimetable(NOW);
  const id = await store.createTimetable('测试', MONDAY + 3, 99, null, NOW);

  const t = await store.timetableById(id);
  assert.equal(t.startDateEpochDay, MONDAY);
  assert.equal(t.totalWeeks, 30);
  assert.equal(t.isPrimary, false);
  // 刚建完当然要看它
  assert.equal(store.currentId, id);
});

test('createTimetable：复制作息后两张课表的作息互相独立', async () => {
  const { store } = makeStore();
  await store.ensureCurrentTimetable(NOW);
  const source = store.currentId;

  const id = await store.createTimetable('复制作息', MONDAY, 20, source, NOW);
  const copied = await store.readSlotsOf(id);
  assert.equal(copied.length, 12);
  assert.deepEqual(
    copied.map((s) => s.periodIndex),
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]
  );

  // 改源课表的第 1 节，目标课表不该变。
  // 注意 saveSlot 会把时段挂到**当前课表**（与 Android 一致），所以先切回源课表
  await store.switchTo(source);
  const srcSlots = await store.readSlotsOf(source);
  const edited = srcSlots[0];
  await store.saveSlot({
    id: edited.id,
    timetableId: edited.timetableId,
    periodIndex: edited.periodIndex,
    label: edited.label,
    startMinute: 7 * 60,
    endMinute: 7 * 60 + 40,
  });
  assert.equal((await store.readSlotsOf(source))[0].startMinute, 7 * 60);
  const after = await store.readSlotsOf(id);
  assert.equal(after.length, 12);
  assert.equal(after[0].startMinute, 8 * 60);
});

test('renameTimetable：空白名不改，正常名照改', async () => {
  const { store } = makeStore();
  await store.ensureCurrentTimetable(NOW);
  const id = store.currentId;

  await store.renameTimetable(id, '   ');
  assert.equal((await store.timetableById(id)).name, '我的课表');

  await store.renameTimetable(id, '2026 春');
  assert.equal((await store.timetableById(id)).name, '2026 春');
});

test('updateTimetableSemester：开学日仍对齐周一、周数仍夹取', async () => {
  const { store } = makeStore();
  await store.ensureCurrentTimetable(NOW);
  const id = store.currentId;

  await store.updateTimetableSemester(id, MONDAY + 5, 0);
  const t = await store.timetableById(id);
  assert.equal(t.startDateEpochDay, MONDAY);
  assert.equal(t.totalWeeks, 1);
});

test('setPrimary：无论之前有几张主课表，之后只有一张', async () => {
  const { store, runner } = makeStore();
  await store.ensureCurrentTimetable(NOW);
  const a = store.currentId;
  const b = await store.createTimetable('B', MONDAY, 20, null, NOW);

  await store.setPrimary(b);
  assert.equal(await runner.scalarInt('SELECT COUNT(*) FROM timetables WHERE isPrimary = 1'), 1);
  assert.equal((await store.timetableById(b)).isPrimary, true);
  assert.equal((await store.timetableById(a)).isPrimary, false);
});

test('deleteTimetable：课程/时段/安排/作息全清，**不留孤儿时段**（外键关着也成立）', async () => {
  // 故意不开 PRAGMA foreign_keys —— relationalStore 没有替我们打开它的保证
  const { store, runner } = makeStore({ foreignKeys: false });
  await store.ensureCurrentTimetable(NOW);
  const id = store.currentId;
  await store.saveCourse(course('数据结构'), [sched(1, 1, 2, WEEKS_1_TO_16)]);
  await store.saveEvent(event('健身'));

  await store.deleteTimetable(id, NOW);

  assert.equal(await runner.scalarInt('SELECT COUNT(*) FROM courses WHERE timetableId = ?', [id]), 0);
  assert.equal(await runner.scalarInt('SELECT COUNT(*) FROM course_schedules'), 0);
  assert.equal(await runner.scalarInt('SELECT COUNT(*) FROM custom_events WHERE timetableId = ?', [id]), 0);
  // 全删光了要自动补一张默认课表（12 节作息），界面永远可用
  assert.equal(await runner.scalarInt('SELECT COUNT(*) FROM timetables'), 1);
  assert.equal(await store.slotCount(), 12);
});

test('deleteTimetable：删的是当前课表 → 自动切到主课表', async () => {
  const { store } = makeStore();
  await store.ensureCurrentTimetable(NOW);
  const primary = store.currentId;
  const second = await store.createTimetable('辅修', MONDAY, 18, null, NOW);
  assert.equal(store.currentId, second);

  await store.deleteTimetable(second, NOW);
  assert.equal(store.currentId, primary);
});

// ---------------------------------------------------------------- 课程

test('saveCourse 新建：返回自增 id，时段挂在这门课上', async () => {
  const { store } = makeStore();
  await store.ensureCurrentTimetable(NOW);

  const id = await store.saveCourse(course('软件工程', { teacher: '张', location: '思源楼-301' }), [
    sched(4, 5, 6, WEEKS_1_TO_16),
    sched(2, 1, 2, WEEKS_1_TO_16),
  ]);
  assert.ok(id > 0);

  const courses = await store.readCoursesOf(store.currentId);
  assert.equal(courses.length, 1);
  assert.equal(courses[0].name, '软件工程');

  const schedules = await store.readSchedulesOf(store.currentId);
  assert.equal(schedules.length, 2);
  for (const s of schedules) {
    assert.equal(s.courseId, id);
  }
  assert.deepEqual(
    schedules.map((s) => [s.dayOfWeek, s.startPeriod, s.endPeriod]),
    [
      [2, 1, 2],
      [4, 5, 6],
    ]
  );
});

test('saveCourse 更新：时段整体替换（旧时段不残留），课程字段更新', async () => {
  const { store } = makeStore();
  await store.ensureCurrentTimetable(NOW);
  const id = await store.saveCourse(course('软件工程'), [sched(1, 1, 2, WEEKS_1_TO_16)]);

  const before = (await store.readCoursesOf(store.currentId))[0];
  await store.saveCourse({ ...before, name: '软件工程（改）', location: '新楼-101' }, [
    sched(3, 5, 6, WEEKS_1_TO_16),
  ]);

  const courses = await store.readCoursesOf(store.currentId);
  assert.equal(courses.length, 1);
  assert.equal(courses[0].id, id);
  assert.equal(courses[0].name, '软件工程（改）');
  assert.equal(courses[0].location, '新楼-101');

  const schedules = await store.readSchedulesOf(store.currentId);
  assert.deepEqual(
    schedules.map((s) => [s.dayOfWeek, s.startPeriod, s.endPeriod]),
    [[3, 5, 6]]
  );
});

test('deleteCourse：时段一起清（外键关着也不留孤儿）', async () => {
  const { store, runner } = makeStore({ foreignKeys: false });
  await store.ensureCurrentTimetable(NOW);
  const id = await store.saveCourse(course('临时课'), [sched(1, 1, 2, WEEKS_1_TO_16)]);

  await store.deleteCourse(id);
  assert.equal(await runner.scalarInt('SELECT COUNT(*) FROM courses'), 0);
  assert.equal(await runner.scalarInt('SELECT COUNT(*) FROM course_schedules'), 0);
});

test('replaceCourses 覆盖导入：旧课清空、自定义安排保留、时段不会挂错课', async () => {
  const { store } = makeStore();
  await store.ensureCurrentTimetable(NOW);
  await store.saveCourse(course('旧课'), [sched(1, 1, 2, WEEKS_1_TO_16)]);
  await store.saveEvent(event('健身'));

  await store.replaceCourses([
    bundle(course('新课一'), [sched(2, 3, 4, WEEKS_1_TO_16)]),
    bundle(course('新课二'), [sched(5, 1, 2, WEEKS_1_TO_16)]),
  ]);

  const courses = await store.readCoursesOf(store.currentId);
  assert.deepEqual(
    courses.map((c) => c.name),
    ['新课一', '新课二']
  );
  const schedules = await store.readSchedulesOf(store.currentId);
  assert.equal(schedules.length, 2);

  // 关键：每条的 courseId 必须指向**它自己那门课**（MAX(id) 取错就会全挂到同一门）
  const byId = new Map<number, string>();
  for (const c of courses) {
    byId.set(c.id, c.name);
  }
  const pairs = schedules.map((s) => [byId.get(s.courseId), s.dayOfWeek]);
  assert.deepEqual(pairs, [
    ['新课一', 2],
    ['新课二', 5],
  ]);

  // 安排是用户自己的，导入课表不该动它
  assert.equal((await store.readEventsOf(store.currentId)).length, 1);
});

test('replaceCourses 空列表：只清空，不报错', async () => {
  const { store } = makeStore();
  await store.ensureCurrentTimetable(NOW);
  await store.saveCourse(course('旧课'), [sched(1, 1, 2, WEEKS_1_TO_16)]);
  await store.replaceCourses([]);
  assert.equal((await store.readCoursesOf(store.currentId)).length, 0);
  assert.equal((await store.readSchedulesOf(store.currentId)).length, 0);
});

test('mergeCourses：同名课程更新时段而不是跳过', async () => {
  const { store } = makeStore();
  await store.ensureCurrentTimetable(NOW);

  const first = await store.mergeCourses([
    bundle(course('高等数学', { teacher: '王', location: '1-101' }), [sched(1, 1, 2, WEEKS_1_TO_16)]),
  ]);
  assert.deepEqual(first, { added: 1, updated: 0 });

  // 同一门课换了星期/节次：必须更新，否则永远留着第一次导入的旧信息
  const second = await store.mergeCourses([
    bundle(course('高等数学', { teacher: '王', location: '1-101', category: '实验' }), [
      sched(2, 3, 4, WEEKS_1_TO_16),
    ]),
  ]);
  assert.deepEqual(second, { added: 0, updated: 1 });

  const courses = await store.readCoursesOf(store.currentId);
  assert.equal(courses.length, 1);
  assert.equal(courses[0].category, '实验');
  const schedules = await store.readSchedulesOf(store.currentId);
  assert.deepEqual(
    schedules.map((s) => [s.dayOfWeek, s.startPeriod, s.endPeriod]),
    [[2, 3, 4]]
  );
});

test('mergeCourses：导入值是空类别时不覆盖已有类别', async () => {
  const { store } = makeStore();
  await store.ensureCurrentTimetable(NOW);
  await store.mergeCourses([bundle(course('物理', { category: '实验' }), [sched(1, 1, 2, WEEKS_1_TO_16)])]);
  await store.mergeCourses([bundle(course('物理', { category: '' }), [sched(1, 1, 2, WEEKS_1_TO_16)])]);
  assert.equal((await store.readCoursesOf(store.currentId))[0].category, '实验');
});

test('mergeCourses：识别同一门课时会去掉首尾空格', async () => {
  const { store } = makeStore();
  await store.ensureCurrentTimetable(NOW);
  await store.mergeCourses([bundle(course('英语', { teacher: '李', location: '2-202' }), [])]);
  const result = await store.mergeCourses([
    bundle(course(' 英语 ', { teacher: ' 李 ', location: ' 2-202 ' }), [sched(3, 3, 4, WEEKS_1_TO_16)]),
  ]);
  assert.deepEqual(result, { added: 0, updated: 1 });
  assert.equal((await store.readCoursesOf(store.currentId)).length, 1);
});

// ---------------------------------------------------------------- 安排 / 作息

test('saveEvent：可空字段原样存取（钟点定位），更新不新建', async () => {
  const { store } = makeStore();
  await store.ensureCurrentTimetable(NOW);
  const id = await store.saveEvent(event('健身'));

  const events = await store.readEventsOf(store.currentId);
  assert.equal(events.length, 1);
  assert.equal(events[0].startPeriod, null);
  assert.equal(events[0].startMinute, 19 * 60);
  assert.equal(events[0].endMinute, 21 * 60);

  await store.saveEvent({ ...events[0], title: '健身（改）', startMinute: 20 * 60 });
  const after = await store.readEventsOf(store.currentId);
  assert.equal(after.length, 1);
  assert.equal(after[0].id, id);
  assert.equal(after[0].title, '健身（改）');
  assert.equal(after[0].startMinute, 20 * 60);
});

test('deleteEvent：只删那一条', async () => {
  const { store } = makeStore();
  await store.ensureCurrentTimetable(NOW);
  const a = await store.saveEvent(event('健身'));
  await store.saveEvent(event('社团'));
  await store.deleteEvent(a);
  const left = await store.readEventsOf(store.currentId);
  assert.deepEqual(
    left.map((e) => e.title),
    ['社团']
  );
});

test('replaceSlots / resetSlots：整表替换，不残留旧节次', async () => {
  const { store } = makeStore();
  await store.ensureCurrentTimetable(NOW);

  await store.replaceSlots([
    { id: 0, timetableId: 0, periodIndex: 1, label: '上午', startMinute: 9 * 60, endMinute: 9 * 60 + 45 },
    { id: 0, timetableId: 0, periodIndex: 2, label: '上午', startMinute: 9 * 60 + 50, endMinute: 10 * 60 + 35 },
  ]);
  const two = await store.readSlotsOf(store.currentId);
  assert.equal(two.length, 2);
  assert.equal(two[0].startMinute, 9 * 60);

  await store.resetSlots();
  const twelve = await store.readSlotsOf(store.currentId);
  assert.equal(twelve.length, 12);
  assert.equal(twelve[0].startMinute, 8 * 60);
  assert.deepEqual(
    twelve.map((s) => s.periodIndex),
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]
  );
});

// ---------------------------------------------------------------- 快照 / 安全

test('snapshot：一次读齐课表 + 作息 + 课程 + 时段 + 安排', async () => {
  const { store } = makeStore();
  await store.ensureCurrentTimetable(NOW);
  await store.saveCourse(course('编译原理'), [sched(2, 3, 4, WEEKS_1_TO_16), sched(4, 1, 2, WEEKS_1_TO_16)]);
  await store.saveEvent(event('自习'));

  const snap = await store.snapshot();
  assert.equal(snap.timetable?.id, store.currentId);
  assert.equal(snap.slots.length, 12);
  assert.equal(snap.courses.length, 1);
  assert.equal(snap.schedules.length, 2);
  assert.equal(snap.events.length, 1);
  // 时段只属于当前课表的课
  for (const s of snap.schedules) {
    assert.equal(s.courseId, snap.courses[0].id);
  }
});

test('掩码安全位：越界直接抛错，不安静存一个错的周次', () => {
  assert.equal(maskToDb(BigInt(0)), 0);
  assert.equal(maskToDb(WEEKS_1_TO_16), 65535);
  assert.throws(() => maskToDb(BigInt(1) << BigInt(53)), /超出可安全存储/);
  assert.throws(() => maskToDb(BigInt(-1)), /不能为负数/);
  assert.throws(() => assertSafeMask(1.5), /不合法/);
  assert.throws(() => assertSafeMask(-1), /不合法/);
});
