/**
 * 导入结果的按课程归并（`data/CourseMerge.ts`）。
 *
 * 这里测的是**"一门课上两次"这件事**：解析器按格子输出，归并之后才能变成
 * "一门课 + 多个时段"。不归并的后果不是排版问题，而是库里真的多出一条课程 ——
 * 改一门只改一半、删一门只删一半、合并导入还会永远更新不到另一条。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { courseKeyOf, mergeCourseItems } from '../entry/src/main/ets/data/CourseMerge.ts';
import type { CourseWithSchedules } from '../entry/src/main/ets/data/models.ts';

const WEEKS_1_TO_16 = 65535;

function course(name: string, teacher = '张老师', location = '教三-201'): CourseWithSchedules['course'] {
  return { id: 0, timetableId: 0, name: name, teacher: teacher, location: location, color: 0, category: '', note: '' };
}

function item(
  name: string,
  sessions: Array<[number, number, number, number]>,
  teacher = '张老师',
  location = '教三-201'
): CourseWithSchedules {
  const schedules = sessions.map(([day, start, end, mask]) => ({
    id: 0,
    courseId: 0,
    dayOfWeek: day,
    startPeriod: start,
    endPeriod: end,
    weekMask: mask,
  }));
  return { course: course(name, teacher, location), schedules: schedules };
}

test('同一门课的两次上课合并成一门课两个时段', () => {
  const out = mergeCourseItems([
    item('软件工程', [[2, 3, 4, WEEKS_1_TO_16]]),
    item('软件工程', [[5, 5, 6, WEEKS_1_TO_16]]),
  ]);
  assert.equal(out.items.length, 1);
  assert.equal(out.items[0].course.name, '软件工程');
  assert.equal(out.items[0].schedules.length, 2);
  assert.equal(out.items[0].schedules[0].dayOfWeek, 2);
  assert.equal(out.items[0].schedules[1].dayOfWeek, 5);
  assert.deepEqual(out.dropped, []);
});

test('教师或地点不同的同名课不合并（它们是不同的课）', () => {
  const out = mergeCourseItems([
    item('大学物理', [[2, 1, 2, WEEKS_1_TO_16]], '张老师', '教三-201'),
    item('大学物理', [[4, 3, 4, WEEKS_1_TO_16]], '李老师', '教三-201'),
    item('大学物理', [[5, 5, 6, WEEKS_1_TO_16]], '张老师', '实验楼-105'),
  ]);
  assert.equal(out.items.length, 3);
});

test('完全重复的时段只留一条，并计数', () => {
  const out = mergeCourseItems([
    item('高等数学', [[2, 3, 4, WEEKS_1_TO_16]]),
    item('高等数学', [[2, 3, 4, WEEKS_1_TO_16]]),
  ]);
  assert.equal(out.items.length, 1);
  assert.equal(out.items[0].schedules.length, 1);
  assert.equal(out.duplicateSchedules, 1);
});

test('周次相同但节次不同的时段不算重复（相邻两段是两件事）', () => {
  const out = mergeCourseItems([
    item('体育', [[1, 1, 2, WEEKS_1_TO_16]]),
    item('体育', [[1, 3, 4, WEEKS_1_TO_16]]),
  ]);
  assert.equal(out.items[0].schedules.length, 2);
  assert.equal(out.duplicateSchedules, 0);
});

test('一条能画的时段都没有的课被丢掉，并报出名字（不做"看不见的数据"）', () => {
  const out = mergeCourseItems([
    item('认不出周次的课', [[3, 1, 2, 0]]),
    item('正常的课', [[3, 3, 4, WEEKS_1_TO_16]]),
  ]);
  assert.equal(out.items.length, 1);
  assert.equal(out.items[0].course.name, '正常的课');
  assert.deepEqual(out.dropped, ['认不出周次的课']);
});

test('同一门课里掩码为 0 的时段被剔掉，好的时段保留', () => {
  const out = mergeCourseItems([
    item('混合课', [[1, 1, 2, WEEKS_1_TO_16], [2, 3, 4, 0]]),
  ]);
  assert.equal(out.items.length, 1);
  assert.equal(out.items[0].schedules.length, 1);
  assert.equal(out.items[0].schedules[0].dayOfWeek, 1);
});

test('顺序按首次出现（预览顺序与 PDF 阅读顺序一致，便于核对）', () => {
  const out = mergeCourseItems([
    item('甲', [[1, 1, 2, WEEKS_1_TO_16]]),
    item('乙', [[2, 1, 2, WEEKS_1_TO_16]]),
    item('甲', [[3, 1, 2, WEEKS_1_TO_16]]),
  ]);
  assert.deepEqual(out.items.map((i) => i.course.name), ['甲', '乙']);
  assert.equal(out.items[0].schedules.length, 2);
});

test('课程键只做"去首尾空格"，不忽略中间差异', () => {
  assert.equal(courseKeyOf(course(' 软件工程 ', ' 张老师 ', ' 教三-201 ')), courseKeyOf(course('软件工程')));
  assert.notEqual(courseKeyOf(course('软件 工程')), courseKeyOf(course('软件工程')));
});

test('空输入不炸', () => {
  const out = mergeCourseItems([]);
  assert.deepEqual(out.items, []);
  assert.deepEqual(out.dropped, []);
  assert.equal(out.duplicateSchedules, 0);
});
