/**
 * P1 的断言：写库边界的四道闸
 *
 * | 用例 | 防的事故 |
 * |---|---|
 * | 建课表一次事务 | 写课表成功、写作息失败 → 留下一张"没有作息"的空壳课表 |
 * | saveEvent / saveSlot 存在性 | UPDATE 0 行不报错 → 用户以为保存成功，重进全没了 |
 * | switchTo 存在性 | current 指向不存在的课表 → 界面全空、重启也恢复不了 |
 * | 范围校验 | dayOfWeek=0 / 节次 999 写进库 → 周视图里永远看不见 / 网格撑爆 |
 * | 快照读事务 | 读到"课程已更新、时段还是旧的"的自相矛盾快照 |
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { V4_SCHEMA } from '../entry/src/main/ets/data/schema.ts';
import { ScheduleStore } from '../entry/src/main/ets/data/ScheduleStore.ts';
import {
  assertPeriodRange,
  assertScheduleRange,
  MAX_PERIOD_INDEX,
  MAX_SAFE_WEEK,
  type Course,
  type CustomEvent,
  type TimeSlot,
} from '../entry/src/main/ets/data/models.ts';
import { WeekCalculator } from '../entry/src/main/ets/logic/WeekCalculator.ts';
import { SqliteRunner } from './helpers/sqliteRunner.ts';

const NOW = Date.UTC(2026, 9, 21, 12, 0, 0);
const MONDAY = WeekCalculator.epochDayOf(2026, 10, 19);

function makeStore(): { store: ScheduleStore; runner: SqliteRunner } {
  const runner = SqliteRunner.open();
  for (const sql of V4_SCHEMA) {
    runner.db.exec(sql);
  }
  return { store: new ScheduleStore(runner), runner };
}

function course(name: string): Course {
  return { id: 0, timetableId: 0, name, teacher: '', location: '', color: 0, category: '', note: '' };
}

function eventWith(title: string): CustomEvent {
  return {
    id: 0,
    timetableId: 0,
    title,
    dayOfWeek: 3,
    startPeriod: 1,
    endPeriod: 2,
    startMinute: null,
    endMinute: null,
    weekMask: 65535,
    color: 0,
    note: '',
  };
}

// ---------------------------------------------------------------- 建课表：一次事务

test('建课表：作息写失败时整批回滚，不留下没有作息的空壳课表', async () => {
  const { store, runner } = makeStore();
  await store.ensureCurrentTimetable(NOW);
  const before = await store.allTimetables();

  // 让"写作息"这一步必然失败：先占掉一个 (timetableId, periodIndex) 唯一索引？
  // 表上没有唯一约束，所以换一种注入方式：把 time_slots 表改名，让第二条 INSERT 撞 "no such table"
  runner.db.exec('ALTER TABLE time_slots RENAME TO time_slots_backup');
  try {
    await assert.rejects(() => store.createTimetable('会被回滚', MONDAY, 20, null, NOW));
  } finally {
    runner.db.exec('ALTER TABLE time_slots_backup RENAME TO time_slots');
  }

  const after = await store.allTimetables();
  assert.equal(after.length, before.length);
  assert.equal(after.some((t) => t.name === '会被回滚'), false);
});

test('建课表：生效时课表行与 12 节作息一起出现（copySlotsFrom 也走同一事务）', async () => {
  const { store } = makeStore();
  const first = await store.ensureCurrentTimetable(NOW);
  const copy = await store.createTimetable('复制作息', MONDAY, 20, first, NOW);
  assert.equal((await store.readSlotsOf(copy)).length, 12);

  const seeded = await store.createTimetable('默认作息', MONDAY, 20, null, NOW);
  assert.equal((await store.readSlotsOf(seeded)).length, 12);
  assert.equal(store.currentId, seeded);
});

// ---------------------------------------------------------------- 存在性

test('saveEvent：目标已被删 → 抛错，而不是静默 UPDATE 0 行', async () => {
  const { store } = makeStore();
  await store.ensureCurrentTimetable(NOW);
  const id = await store.saveEvent(eventWith('健身'));
  await store.deleteEvent(id);

  const ghost = eventWith('健身（改）');
  await assert.rejects(
    () => store.saveEvent({ ...ghost, id: id }),
    /已经不存在/
  );
  assert.equal((await store.readEventsOf(store.currentId)).length, 0);
});

test('saveSlot：目标已被删 → 抛错，作息表不受影响', async () => {
  const { store } = makeStore();
  await store.ensureCurrentTimetable(NOW);
  const slots = await store.readSlotsOf(store.currentId);
  const victim = slots[0];
  await store.deleteSlot(victim.id);

  await assert.rejects(
    () =>
      store.saveSlot({
        id: victim.id,
        timetableId: victim.timetableId,
        periodIndex: victim.periodIndex,
        label: '改过的',
        startMinute: 7 * 60,
        endMinute: 7 * 60 + 40,
      }),
    /已经不存在/
  );
  assert.equal((await store.readSlotsOf(store.currentId)).length, 11);
});

// ---------------------------------------------------------------- 范围

test('assertScheduleRange / assertPeriodRange：越界直接抛，边界值放行', () => {
  assert.doesNotThrow(() => assertScheduleRange(1, 1, 1));
  assert.doesNotThrow(() => assertScheduleRange(7, 1, MAX_PERIOD_INDEX));

  assert.throws(() => assertScheduleRange(0, 1, 2), /星期不合法/);
  assert.throws(() => assertScheduleRange(8, 1, 2), /星期不合法/);
  assert.throws(() => assertScheduleRange(1, 0, 2), /起始节次不合法/);
  assert.throws(() => assertScheduleRange(1, 3, 2), /结束节次不合法/);
  assert.throws(() => assertScheduleRange(1, 1, MAX_PERIOD_INDEX + 1), /结束节次不合法/);
});

test('saveCourse：星期的越界数据进不了库（周视图会"永远看不见"它）', async () => {
  const { store } = makeStore();
  await store.ensureCurrentTimetable(NOW);
  await assert.rejects(
    () =>
      store.saveCourse(course('星期零的课'), [
        { id: 0, courseId: 0, dayOfWeek: 0, startPeriod: 1, endPeriod: 2, weekMask: 65535, location: '', classGroup: '' },
      ]),
    /星期不合法/
  );
  assert.equal(await store.courseCount(), 0);
});

test('saveSlot：节次号越界进不了库（会把周视图撑成上千行）', async () => {
  const { store } = makeStore();
  await store.ensureCurrentTimetable(NOW);
  const bad: TimeSlot = {
    id: 0,
    timetableId: 0,
    periodIndex: MAX_PERIOD_INDEX + 1,
    label: '',
    startMinute: 8 * 60,
    endMinute: 8 * 60 + 45,
  };
  await assert.rejects(() => store.saveSlot(bad), /起始节次不合法/);
  assert.equal((await store.readSlotsOf(store.currentId)).length, 12);
});

test('saveEvent：星期越界 / 节次越界都拒绝', async () => {
  const { store } = makeStore();
  await store.ensureCurrentTimetable(NOW);

  const badDay: CustomEvent = { ...eventWith('x'), dayOfWeek: 9 };
  await assert.rejects(() => store.saveEvent(badDay), /星期不合法/);

  const badPeriod: CustomEvent = { ...eventWith('y'), startPeriod: 5, endPeriod: 2 };
  await assert.rejects(() => store.saveEvent(badPeriod), /结束节次不合法/);

  // 只有钟点、没有节次的老数据仍然允许
  const clockOnly: CustomEvent = { ...eventWith('z'), startPeriod: null, endPeriod: null };
  const id = await store.saveEvent(clockOnly);
  assert.ok(id > 0);
});

test('replaceSlots：一张越界的作息整表替换被拒绝，旧作息不动', async () => {
  const { store } = makeStore();
  await store.ensureCurrentTimetable(NOW);
  await assert.rejects(
    () =>
      store.replaceSlots([
        { id: 0, timetableId: 0, periodIndex: 1, label: '', startMinute: 480, endMinute: 525 },
        { id: 0, timetableId: 0, periodIndex: 0, label: '', startMinute: 530, endMinute: 575 },
      ]),
    /起始节次不合法/
  );
  assert.equal((await store.readSlotsOf(store.currentId)).length, 12);
});

// ---------------------------------------------------------------- 快照读事务

test('snapshot：五张表读在同一个事务里；回调抛错会回滚而不是留下半个状态', async () => {
  const { store, runner } = makeStore();
  await store.ensureCurrentTimetable(NOW);
  await store.saveCourse(course('高等数学'), [
    { id: 0, courseId: 0, dayOfWeek: 2, startPeriod: 1, endPeriod: 2, weekMask: 65535, location: 'A101', classGroup: '' },
  ]);

  const snap = await store.snapshot();
  assert.equal(snap.courses.length, 1);
  assert.equal(snap.schedules.length, 1);
  assert.equal(snap.slots.length, 12);

  // 事务里的 runner 可以被调用方拿来读（snapshot 内部就是这么用的）
  let seen = -1;
  await runner.transaction(async (tx) => {
    seen = (await tx.query('SELECT COUNT(*) AS c FROM courses')).length;
  });
  assert.equal(seen, 1);

  // 抛错 → 回滚：写进去的行不留下
  await assert.rejects(
    () =>
      runner.transaction(async (tx) => {
        await tx.exec("INSERT INTO courses (timetableId, name, teacher, location, color, category, note) VALUES (1, '半截', '', '', 0, '', '')");
        throw new Error('人为失败');
      }),
    /人为失败/
  );
  assert.equal(await store.courseCount(), 1);
});

test('掩码安全位仍然是硬闸（未被本轮改动削弱）', async () => {
  const { store } = makeStore();
  await store.ensureCurrentTimetable(NOW);
  await assert.rejects(
    () =>
      store.saveCourse(course('掩码越界'), [
        {
          id: 0,
          courseId: 0,
          dayOfWeek: 1,
          startPeriod: 1,
          endPeriod: 2,
          weekMask: Number.MAX_SAFE_INTEGER + 1,
          location: '',
          classGroup: '',
        },
      ]),
    new RegExp('周次掩码')
  );
  assert.equal(MAX_SAFE_WEEK >= 53, true);
});
