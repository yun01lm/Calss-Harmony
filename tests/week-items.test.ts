/**
 * 周视图"每周色块"的断言（`logic/WeekItems.ts` + `logic/Colors.ts`）。
 *
 * 这里测的是**这一周该看到哪些课**：周次掩码命中、脏数据跳过、冲突标出、自定义安排不漏。
 * 画法（格子多大、几行字）在 `CellLayout` 里单独测，两者分开。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { Colors } from '../entry/src/main/ets/logic/Colors.ts';
import { WeekItems } from '../entry/src/main/ets/logic/WeekItems.ts';
import type {
  CourseLike,
  EventLike,
  ScheduleLike,
  SlotLike,
} from '../entry/src/main/ets/logic/WeekItems.ts';

// ---------------------------------------------------------------- 工具

const WEEKS_1_TO_16 = 65535; // (1 << 16) - 1
const ODD_1_TO_15 = 21845; // 0b0101_0101_0101_0101

function course(id: number, name: string, location = '思源楼-301', color = 0): CourseLike {
  return { id: id, name: name, location: location, color: color };
}

function schedule(
  courseId: number,
  dayOfWeek: number,
  startPeriod: number,
  endPeriod: number,
  weekMask = WEEKS_1_TO_16
): ScheduleLike {
  return {
    courseId: courseId,
    dayOfWeek: dayOfWeek,
    startPeriod: startPeriod,
    endPeriod: endPeriod,
    weekMask: weekMask,
  };
}

function event(id: number, title: string, dayOfWeek: number, startPeriod: number | null): EventLike {
  return {
    id: id,
    title: title,
    dayOfWeek: dayOfWeek,
    startPeriod: startPeriod,
    endPeriod: startPeriod === null ? null : startPeriod + 1,
    weekMask: WEEKS_1_TO_16,
    color: 0,
    note: '备注',
  };
}

function slots(count: number): SlotLike[] {
  const out: SlotLike[] = [];
  for (let i = 1; i <= count; i++) {
    out.push({ periodIndex: i });
  }
  return out;
}

// ---------------------------------------------------------------- 周次命中

test('build：只有掩码命中的周才有色块', () => {
  const weeks = WeekItems.build({
    courses: [course(1, '软件工程')],
    schedules: [schedule(1, 4, 5, 6, WEEKS_1_TO_16)],
    events: [],
    totalWeeks: 20,
  });
  assert.equal(weeks.length, 20);
  assert.equal(WeekItems.itemsOf(weeks, 1).length, 1);
  assert.equal(WeekItems.itemsOf(weeks, 16).length, 1);
  assert.equal(WeekItems.itemsOf(weeks, 17).length, 0);
  assert.equal(WeekItems.itemsOf(weeks, 20).length, 0);
});

test('build：单周课只在单周出现', () => {
  const weeks = WeekItems.build({
    courses: [course(1, '体育')],
    schedules: [schedule(1, 3, 7, 8, ODD_1_TO_15)],
    events: [],
    totalWeeks: 16,
  });
  assert.equal(WeekItems.itemsOf(weeks, 1).length, 1);
  assert.equal(WeekItems.itemsOf(weeks, 2).length, 0);
  assert.equal(WeekItems.itemsOf(weeks, 15).length, 1);
  assert.equal(WeekItems.itemsOf(weeks, 16).length, 0);
});

test('build：课程已被删、只剩时段（脏数据）时不画无名块', () => {
  const weeks = WeekItems.build({
    courses: [course(1, '软件工程')],
    schedules: [schedule(1, 1, 1, 2), schedule(99, 2, 3, 4)],
    events: [],
    totalWeeks: 16,
  });
  const items = WeekItems.itemsOf(weeks, 1);
  assert.equal(items.length, 1);
  assert.equal(items[0].title, '软件工程');
});

// ---------------------------------------------------------------- 内容

test('build：课程显示短教室，颜色按名字稳定', () => {
  const weeks = WeekItems.build({
    courses: [course(1, '软件工程', '本部-计算机基础实验室-2(503-504)')],
    schedules: [schedule(1, 4, 5, 6)],
    events: [],
    totalWeeks: 16,
  });
  const item = WeekItems.itemsOf(weeks, 1)[0];
  assert.equal(item.kind, WeekItems.KIND_COURSE);
  assert.equal(item.subtitle, '实验室503-504');
  assert.equal(item.color, Colors.colorFor('软件工程', 0));
  // 同名课程每一周都是同一个颜色
  assert.equal(WeekItems.itemsOf(weeks, 2)[0].color, item.color);
});

test('build：显式颜色优先于按名散列，且负数 ARGB 能还原', () => {
  // 0xFFE07A5F 在 Kotlin Int 里是 -2065825；JS 读出来可能就是这个负数
  const explicit = -2065825;
  const weeks = WeekItems.build({
    courses: [course(1, '软件工程', '思源楼-301', explicit)],
    schedules: [schedule(1, 4, 5, 6)],
    events: [],
    totalWeeks: 16,
  });
  assert.equal(WeekItems.itemsOf(weeks, 1)[0].color, '#E07A5F');
});

test('build：自定义安排进网格，副标题是备注，默认色与课程不同', () => {
  const weeks = WeekItems.build({
    courses: [],
    schedules: [],
    events: [event(1, '健身', 6, 9)],
    totalWeeks: 16,
  });
  const item = WeekItems.itemsOf(weeks, 1)[0];
  assert.equal(item.kind, WeekItems.KIND_EVENT);
  assert.equal(item.subtitle, '备注');
  assert.equal(item.startPeriod, 9);
  assert.equal(item.endPeriod, 10);
  assert.equal(item.color, Colors.EVENT_COLOR);
});

test('build：只有钟点没有节次的安排不画（网格纵轴是节次）', () => {
  const weeks = WeekItems.build({
    courses: [],
    schedules: [],
    events: [event(1, '自习', 2, null)],
    totalWeeks: 16,
  });
  assert.equal(WeekItems.itemsOf(weeks, 1).length, 0);
});

test('build：安排没填结束节次时，占它自己那一节', () => {
  const weeks = WeekItems.build({
    courses: [],
    schedules: [],
    events: [
      {
        id: 1,
        title: '交作业',
        dayOfWeek: 5,
        startPeriod: 4,
        endPeriod: null,
        weekMask: WEEKS_1_TO_16,
        color: 0,
        note: '',
      },
    ],
    totalWeeks: 16,
  });
  const item = WeekItems.itemsOf(weeks, 1)[0];
  assert.equal(item.startPeriod, 4);
  assert.equal(item.endPeriod, 4);
});

// ---------------------------------------------------------------- 冲突

test('build：同一格时间重叠的两门课互相点名', () => {
  const weeks = WeekItems.build({
    courses: [course(1, '软件工程'), course(2, '操作系统')],
    schedules: [schedule(1, 1, 3, 4), schedule(2, 1, 3, 4)],
    events: [],
    totalWeeks: 16,
  });
  const items = WeekItems.itemsOf(weeks, 1);
  assert.equal(items.length, 2);
  assert.deepEqual(items[0].conflicts, ['操作系统']);
  assert.deepEqual(items[1].conflicts, ['软件工程']);
});

test('build：不同天的课不算冲突', () => {
  const weeks = WeekItems.build({
    courses: [course(1, 'A'), course(2, 'B')],
    schedules: [schedule(1, 1, 3, 4), schedule(2, 2, 3, 4)],
    events: [],
    totalWeeks: 16,
  });
  const items = WeekItems.itemsOf(weeks, 1);
  assert.deepEqual(items[0].conflicts, []);
  assert.deepEqual(items[1].conflicts, []);
});

test('build：首尾相接（第 3-4 节 + 第 4-5 节）算冲突，紧邻（3-4 + 5-6）不算', () => {
  const overlap = WeekItems.build({
    courses: [course(1, 'A'), course(2, 'B')],
    schedules: [schedule(1, 1, 3, 4), schedule(2, 1, 4, 5)],
    events: [],
    totalWeeks: 16,
  });
  assert.equal(WeekItems.itemsOf(overlap, 1)[0].conflicts.length, 1);

  const adjacent = WeekItems.build({
    courses: [course(1, 'A'), course(2, 'B')],
    schedules: [schedule(1, 1, 3, 4), schedule(2, 1, 5, 6)],
    events: [],
    totalWeeks: 16,
  });
  assert.equal(WeekItems.itemsOf(adjacent, 1)[0].conflicts.length, 0);
});

// ---------------------------------------------------------------- 行数

test('periodCount：取作息最大节次、色块最大结束节次、下限 8 三者最大', () => {
  const empty = WeekItems.build({ courses: [], schedules: [], events: [], totalWeeks: 4 });
  // 只有 4 节课也留 8 行
  assert.equal(WeekItems.periodCount(slots(4), empty), 8);
  // 作息有 12 节
  assert.equal(WeekItems.periodCount(slots(12), empty), 12);
  // 数据里出现了第 14 节（导入的课表比作息长）
  const long = WeekItems.build({
    courses: [course(1, '晚课')],
    schedules: [schedule(1, 1, 13, 14)],
    events: [],
    totalWeeks: 16,
  });
  assert.equal(WeekItems.periodCount(slots(12), long), 14);
});

test('itemsOf：越界返回空数组，不抛错', () => {
  const weeks = WeekItems.build({ courses: [], schedules: [], events: [], totalWeeks: 3 });
  assert.deepEqual(WeekItems.itemsOf(weeks, 0), []);
  assert.deepEqual(WeekItems.itemsOf(weeks, 4), []);
});

// ---------------------------------------------------------------- 配色

test('Colors.kotlinHashCode：与 Java/Kotlin 的 String.hashCode 一致', () => {
  assert.equal(Colors.kotlinHashCode(''), 0);
  assert.equal(Colors.kotlinHashCode('a'), 97);
  assert.equal(Colors.kotlinHashCode('abc'), 96354);
  assert.equal(Colors.kotlinHashCode('hello'), 99162322);
});

test('Colors.colorFor：同名同色、异名可不同、显式色优先', () => {
  const a = Colors.colorFor('软件工程', 0);
  assert.equal(Colors.colorFor('软件工程', 0), a);
  assert.ok(Colors.PALETTE.indexOf(a) >= 0);
  assert.equal(Colors.colorFor('软件工程', -2065825), '#E07A5F');
});

test('Colors.fromDb / withAlpha', () => {
  assert.equal(Colors.fromDb(0), '#000000');
  assert.equal(Colors.fromDb(-2065825), '#E07A5F');
  assert.equal(Colors.fromDb(4292901471), '#E07A5F');
  assert.equal(Colors.withAlpha('#E07A5F', 0.16), '#29E07A5F');
  assert.equal(Colors.withAlpha('#E07A5F', 1), '#FFE07A5F');
});
