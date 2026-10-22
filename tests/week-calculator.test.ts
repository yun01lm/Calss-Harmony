/** WeekCalculator 断言（移植自 verify_week_logic.py 的 36 条 + 时区/闰年整数天用例） */
import test from 'node:test';
import assert from 'node:assert/strict';

import { WeekCalculator } from '../entry/src/main/ets/logic/WeekCalculator.ts';

const D = (y: number, m: number, d: number): number => WeekCalculator.epochDayOf(y, m, d);
const iso = (e: number): string => WeekCalculator.isoDate(e);
const TODAY = D(2026, 10, 9); // 用户实测那天（周五）

test('currentWeek：开学当天 / 第一周周日 / 第二周周一', () => {
  assert.equal(WeekCalculator.currentWeek(D(2026, 9, 7), D(2026, 9, 7)), 1);
  assert.equal(WeekCalculator.currentWeek(D(2026, 9, 7), D(2026, 9, 13)), 1);
  assert.equal(WeekCalculator.currentWeek(D(2026, 9, 7), D(2026, 9, 14)), 2);
});

test('currentWeek：开学前一律按第 1 周', () => {
  assert.equal(WeekCalculator.currentWeek(D(2026, 9, 7), D(2026, 8, 20)), 1);
  assert.equal(WeekCalculator.currentWeek(D(2026, 9, 7), D(2025, 1, 1)), 1);
});

test('currentWeek：用户实测两个真值', () => {
  assert.equal(WeekCalculator.currentWeek(D(2026, 9, 7), TODAY), 5);
  assert.equal(WeekCalculator.currentWeek(D(2026, 9, 14), TODAY), 4);
});

test('currentWeek：学期末与超出学期', () => {
  const start = D(2026, 9, 7);
  assert.equal(WeekCalculator.currentWeek(start, start + 19 * 7 + 6), 20, '第 20 周最后一天');
  assert.equal(WeekCalculator.currentWeek(start, start + 20 * 7), 21, '第 21 周（超出学期）');
});

test('startDateForWeek 与 currentWeek 严格互逆（1~20 周 × 3 个"今天"）', () => {
  const todays = [D(2026, 10, 5), TODAY, D(2026, 10, 11)];
  for (const t of todays) {
    for (let n = 1; n <= 20; n++) {
      const start = WeekCalculator.startDateForWeek(n, t);
      assert.equal(WeekCalculator.currentWeek(start, t), n,
        `互逆失败：周次=${n} 今天=${iso(t)}`);
    }
  }
});

test('startDateForWeek 的结果总是周一', () => {
  const todays = [D(2026, 10, 5), TODAY, D(2026, 10, 11)];
  for (const t of todays) {
    for (const n of [1, 2, 5, 20]) {
      assert.equal(WeekCalculator.weekdayOfEpochDay(WeekCalculator.startDateForWeek(n, t)), 1,
        `不是周一：${n} @ ${iso(t)}`);
    }
  }
});

test('startDateForWeek：具体反推值（用户场景）', () => {
  assert.equal(iso(WeekCalculator.startDateForWeek(5, TODAY)), '2026-09-07');
  assert.equal(iso(WeekCalculator.startDateForWeek(1, TODAY)), '2026-10-05');
  assert.equal(iso(WeekCalculator.startDateForWeek(0, TODAY)), '2026-10-05', '周次 0 视为第 1 周');
});

test('weekdayOfEpochDay：1970-01-01 是周四；2026-09-07 是周一', () => {
  assert.equal(WeekCalculator.weekdayOfEpochDay(0), 4);
  assert.equal(WeekCalculator.weekdayOfEpochDay(D(2026, 9, 7)), 1);
  assert.equal(WeekCalculator.weekdayOfEpochDay(D(2026, 10, 9)), 5, '周五');
  assert.equal(WeekCalculator.weekdayOfEpochDay(D(2026, 10, 11)), 7, '周日');
});

test('mondayOfEpochDay：周一取自己，周日取往前 6 天', () => {
  assert.equal(WeekCalculator.mondayOfEpochDay(D(2026, 9, 7)), D(2026, 9, 7));
  assert.equal(WeekCalculator.mondayOfEpochDay(D(2026, 10, 9)), D(2026, 10, 5));
  assert.equal(WeekCalculator.mondayOfEpochDay(D(2026, 10, 11)), D(2026, 10, 5));
});

test('epochDayOf / dateOf / isoDate 往返一致', () => {
  assert.equal(iso(D(2026, 9, 7)), '2026-09-07');
  assert.equal(iso(D(2026, 1, 1)), '2026-01-01');
  assert.deepEqual(WeekCalculator.dateOf(D(2026, 12, 31)), { year: 2026, month: 12, day: 31 });
  assert.equal(D(2026, 3, 1) - D(2026, 2, 28), 1, '2026 非闰年');
  assert.equal(D(2028, 3, 1) - D(2028, 2, 28), 2, '2028 闰年');
});

test('todayEpochDay：按**本地**日期取今天（跨时区不偏移一天）', () => {
  assert.equal(WeekCalculator.todayEpochDay(new Date(2026, 9, 9, 0, 30, 0)), D(2026, 10, 9));
  assert.equal(WeekCalculator.todayEpochDay(new Date(2026, 9, 9, 23, 30, 0)), D(2026, 10, 9));
});

test('整数天运算：跨夏令时的月份也不差一天', () => {
  assert.equal(D(2026, 11, 1) - D(2026, 10, 25), 7);
  assert.equal(D(2026, 3, 30) - D(2026, 3, 23), 7);
});
