/**
 * 课程编辑面板的断言（`logic/CourseDraft.ts` + `WeekCalculator.epochDayOfIso`）。
 *
 * 这里测的是**用户输入这一侧**的规则：能自动纠正的（全角、`~`、「周」字、起止填反）
 * 一律纠正后放行并在输入框里回显；纠正不了的才报错，而且要说清是第几段。
 *
 * 不测画法，也不碰数据库 —— 那些在 `cell-layout.test.ts` / `store.test.ts` 里。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { CourseDraft } from '../entry/src/main/ets/logic/CourseDraft.ts';
import type { DraftRow, DraftResult } from '../entry/src/main/ets/logic/CourseDraft.ts';
import { WeekCalculator } from '../entry/src/main/ets/logic/WeekCalculator.ts';

// ---------------------------------------------------------------- 工具

const WEEKS_1_TO_16 = 65535; // (1 << 16) - 1
const ODD_1_TO_15 = 21845; // 0b0101_0101_0101_0101

function check(name: string, rows: DraftRow[], periodCount = 12): DraftResult {
  return CourseDraft.check(name, '', '', rows, periodCount);
}

function one(weeks: string, day = 2, start = 3, end = 4): DraftRow[] {
  return [CourseDraft.row(day, start, end, weeks)];
}

// ---------------------------------------------------------------- 正常路径

test('周次 1-16 得到覆盖 16 周的掩码', () => {
  const r: DraftResult = check('高等数学', one('1-16'));
  assert.equal(r.error, '');
  assert.equal(r.badRow, CourseDraft.BAD_ROW_NONE);
  assert.equal(r.schedules.length, 1);
  assert.equal(r.schedules[0].dayOfWeek, 2);
  assert.equal(r.schedules[0].startPeriod, 3);
  assert.equal(r.schedules[0].endPeriod, 4);
  assert.equal(Number(r.schedules[0].weekMask), WEEKS_1_TO_16);
});

test('一门课可以有多段上课时间（各段独立掩码）', () => {
  const rows: DraftRow[] = [
    CourseDraft.row(1, 1, 2, '1-8'),
    CourseDraft.row(3, 5, 6, '9-16'),
  ];
  const r: DraftResult = check('大学物理', rows);
  assert.equal(r.error, '');
  assert.equal(r.schedules.length, 2);
  assert.equal(Number(r.schedules[0].weekMask), 255); // 第 1-8 周
  assert.equal(Number(r.schedules[1].weekMask), 65280); // 第 9-16 周
});

test('名称、教师、地点两端空白被去掉', () => {
  const r: DraftResult = CourseDraft.check('  线性代数  ', ' 张老师 ', ' 教三-201 ', one('1-16'), 12);
  assert.equal(r.name, '线性代数');
  assert.equal(r.teacher, '张老师');
  assert.equal(r.location, '教三-201');
});

// ---------------------------------------------------------------- 自动纠正

test('起止节填反自动对调（不是报错，也不是空区间）', () => {
  const r: DraftResult = check('课程', one('1-16', 4, 7, 2));
  assert.equal(r.error, '');
  assert.equal(r.schedules[0].startPeriod, 2);
  assert.equal(r.schedules[0].endPeriod, 7);
});

test('全角周次与全角减号被纠正', () => {
  const r: DraftResult = check('课程', one('１－１６'));
  assert.equal(r.error, '');
  assert.equal(Number(r.schedules[0].weekMask), WEEKS_1_TO_16);
  // 回填给输入框的是规范写法，用户能看见改成了什么
  assert.equal(r.rows[0].weeks, '1-16');
});

test('"1~8周" 与 "1,2,3" 被压缩成规范写法', () => {
  const a: DraftResult = check('课程', one('1~8周'));
  assert.equal(a.error, '');
  assert.equal(a.rows[0].weeks, '1-8');
  assert.equal(Number(a.schedules[0].weekMask), 255);

  const b: DraftResult = check('课程', one('1,2,3'));
  assert.equal(b.error, '');
  assert.equal(b.rows[0].weeks, '1-3');
  assert.equal(Number(b.schedules[0].weekMask), 7);
});

test('单双周写法保住单周（1-15单）', () => {
  const r: DraftResult = check('课程', one('1-15周(单)'));
  assert.equal(r.error, '');
  assert.equal(Number(r.schedules[0].weekMask), ODD_1_TO_15);
  assert.equal(r.rows[0].weeks, '1-15单');
});

test('星期越界与节次超出作息范围被夹住（不报错，否则表单没法修）', () => {
  const r: DraftResult = check('课程', one('1-16', 9, 99, 0), 12);
  assert.equal(r.error, '');
  assert.equal(r.schedules[0].dayOfWeek, 7);
  assert.equal(r.schedules[0].startPeriod, 1);
  assert.equal(r.schedules[0].endPeriod, 12);
});

// ---------------------------------------------------------------- 报错

test('课程名为空 → 第一条错就是这个，而不是先说周次', () => {
  const r: DraftResult = check('   ', one('乱写'));
  assert.equal(r.error, '请输入课程名称');
  assert.equal(r.badRow, CourseDraft.BAD_ROW_NONE);
  assert.equal(r.schedules.length, 0);
});

test('一个上课时段都没有 → 明确拒绝', () => {
  const r: DraftResult = check('课程', []);
  assert.equal(r.error, '至少需要一个上课时段');
});

test('周次认不出任何一周 → 指出是第几段', () => {
  const rows: DraftRow[] = [
    CourseDraft.row(1, 1, 2, '1-16'),
    CourseDraft.row(3, 5, 6, '周次待定'),
  ];
  const r: DraftResult = check('课程', rows);
  assert.equal(r.badRow, 1);
  assert.ok(r.error.startsWith('第 2 段的周次没填对'));
  assert.ok(r.error.includes('1-16'));
  assert.equal(r.schedules.length, 0);
});

test('"第1-3周" 这种未知写法被挡下（不静默变成只剩第 3 周）', () => {
  const r: DraftResult = check('课程', one('第1-3周'));
  assert.equal(r.badRow, 0);
  assert.ok(r.error.length > 0);
});

test('报错时仍然回填规范化后的行，且把认不出的原文留着', () => {
  const rows: DraftRow[] = [
    CourseDraft.row(2, 5, 3, '１－８'),
    CourseDraft.row(4, 7, 9, '待定'),
  ];
  const r: DraftResult = check('课程', rows);
  assert.equal(r.error.length > 0, true);
  assert.equal(r.rows.length, 2);
  assert.equal(r.rows[0].weeks, '1-8');
  assert.equal(r.rows[0].start, 3);
  assert.equal(r.rows[0].end, 5);
  assert.equal(r.rows[1].weeks, '待定');
});

// ---------------------------------------------------------------- 载荷

test('payloadOf 只在通过时给载荷', () => {
  const ok: DraftResult = check('高等数学', one('1-16'));
  const payload = CourseDraft.payloadOf(ok);
  assert.notEqual(payload, null);
  assert.equal(payload?.name, '高等数学');
  assert.equal(payload?.schedules.length, 1);

  assert.equal(CourseDraft.payloadOf(check('', one('1-16'))), null);
});

// ---------------------------------------------------------------- 新建默认值与显示

test('点空白格新建的默认行：该格星期/节次，止节顺延一节，周次 1-16', () => {
  const row: DraftRow = CourseDraft.newRow(3, 5, 12);
  assert.equal(row.day, 3);
  assert.equal(row.start, 5);
  assert.equal(row.end, 6);
  assert.equal(row.weeks, '1-16');
});

test('最后一节新建时止节不越界', () => {
  const row: DraftRow = CourseDraft.newRow(1, 12, 12);
  assert.equal(row.start, 12);
  assert.equal(row.end, 12);
});

test('dayName 与 rowSummary 的显示', () => {
  assert.equal(CourseDraft.dayName(1), '周一');
  assert.equal(CourseDraft.dayName(7), '周日');
  assert.equal(CourseDraft.dayName(99), '周日');
  assert.equal(CourseDraft.rowSummary(CourseDraft.row(2, 3, 4, '1-16')), '周二 3-4 节 · 1-16 周');
  assert.equal(CourseDraft.rowSummary(CourseDraft.row(2, 3, 4, '  ')), '周二 3-4 节 · 未填周次 周');
});

// ---------------------------------------------------------------- 开学日解析

test('开学日 "yyyy-MM-dd" 能转成 epochDay 且与 isoDate 互逆', () => {
  const epochDay = WeekCalculator.epochDayOfIso('2026-09-07');
  assert.notEqual(epochDay, null);
  assert.equal(WeekCalculator.isoDate(epochDay as number), '2026-09-07');
  // 2026-09-07 是周一：开学日本身就该是周一
  assert.equal(WeekCalculator.weekdayOfEpochDay(epochDay as number), 1);
});

test('不存在的日期被拒绝（不做日期滚动）', () => {
  assert.equal(WeekCalculator.epochDayOfIso('2026-02-30'), null);
  assert.equal(WeekCalculator.epochDayOfIso('2026-13-01'), null);
  assert.equal(WeekCalculator.epochDayOfIso('2026/09/07'), null);
});

// ---------------------------------------------------------------- 与存储边界对齐

test('周次超过 53 周被挡在输入侧（否则写库时才抛错，界面像"点了没反应"）', () => {
  // WeekMasks 能表示到 64 周，但库里是 JS number（2^53 上界 = 第 53 周）
  const ok = check('课程', one('1-53'));
  assert.equal(ok.error, '');

  const tooFar = check('课程', one('1-64'));
  assert.equal(tooFar.badRow, 0);
  assert.ok(tooFar.error.indexOf('可保存范围') >= 0);
  assert.equal(tooFar.schedules.length, 0);

  const single = check('课程', one('54'));
  assert.ok(single.error.indexOf('可保存范围') >= 0);
});
