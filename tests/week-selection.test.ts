/**
 * 「打开即当前周」两条抑制规则的断言（`logic/WeekSelection.ts`）。
 *
 * 这里除了单条规则，还用一个小状态机**完整复演**真机上的时序：
 * 首帧回调 → 程序化跳周（经过中间页）→ 用户滑 → 程序化回本周 → 再滑。
 * 因为 Android 侧那两个 bug 都不是"某条规则写错"，而是"两条规则配合起来漏了一种时序"。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { WeekSelection } from '../entry/src/main/ets/logic/WeekSelection.ts';

test('clamp：周次夹在 1..totalWeeks，totalWeeks 为 0 也不炸', () => {
  assert.equal(WeekSelection.clamp(5, 20), 5);
  assert.equal(WeekSelection.clamp(0, 20), 1);
  assert.equal(WeekSelection.clamp(-3, 20), 1);
  assert.equal(WeekSelection.clamp(25, 20), 20);
  assert.equal(WeekSelection.clamp(3, 0), 1);
});

test('pageOf / weekOfPage：页下标与周次互转', () => {
  assert.equal(WeekSelection.pageOf(1), 0);
  assert.equal(WeekSelection.pageOf(12), 11);
  assert.equal(WeekSelection.weekOfPage(0), 1);
  assert.equal(WeekSelection.weekOfPage(11), 12);
});

test('initialWeek：打开时跟随当前周，并夹在学期内', () => {
  assert.equal(WeekSelection.initialWeek(5, 20), 5);
  // 学期已结束（当前周 > 总周数）→ 停在最后一周
  assert.equal(WeekSelection.initialWeek(22, 20), 20);
  // 还没开学 → 停在第一周
  assert.equal(WeekSelection.initialWeek(0, 20), 1);
});

test('shouldReport：程序化翻页期间一律不上报（含中间页）', () => {
  // 从第 1 周跳到第 10 周，中途经过 3、6、9
  assert.equal(WeekSelection.shouldReport(3, 10, true), false);
  assert.equal(WeekSelection.shouldReport(9, 10, true), false);
  assert.equal(WeekSelection.shouldReport(10, 10, true), false);
});

test('shouldReport：目标页与当前显示相同则不上报（瞬时判据）', () => {
  assert.equal(WeekSelection.shouldReport(6, 6, false), false);
  assert.equal(WeekSelection.shouldReport(6, 5, false), true);
});

/**
 * 模拟页面的状态机：`selectedWeek` 是"当前显示的周"，`autoScrolling` 是程序化翻页标记。
 * 与 `pages/Index.ets` 里的写法完全一致（程序化翻页前先把 selectedWeek 设成目标周）。
 */
class PagerSim {
  selectedWeek: number;
  autoScrolling: boolean = false;
  /** 被当成"用户选周"的上报记录 */
  readonly reported: number[] = [];
  private readonly totalWeeks: number;

  constructor(week: number, totalWeeks: number) {
    this.totalWeeks = totalWeeks;
    this.selectedWeek = WeekSelection.initialWeek(week, totalWeeks);
  }

  /** Swiper 的 onChange 回调 */
  onChange(page: number): void {
    const pageWeek = WeekSelection.weekOfPage(page);
    if (WeekSelection.shouldReport(pageWeek, this.selectedWeek, this.autoScrolling)) {
      this.selectedWeek = pageWeek;
      this.reported.push(pageWeek);
    }
  }

  /** 程序化翻页：先把状态改成目标，再压住这段动画期间的回调，最后放开 */
  goTo(week: number, pages: number[]): void {
    const target = WeekSelection.clamp(week, this.totalWeeks);
    this.selectedWeek = target;
    this.autoScrolling = true;
    for (const p of pages) {
      this.onChange(p);
    }
    this.autoScrolling = false;
  }
}

test('时序复演：首帧停在第 1 页不会把"跟随当前周"关掉', () => {
  const sim = new PagerSim(5, 20);
  // 首帧：数据还没到，Swiper 停在第 0 页；此时 autoScrolling 为真（页面对齐到第 5 周）
  sim.autoScrolling = true;
  sim.onChange(0);
  sim.autoScrolling = false;

  assert.equal(sim.selectedWeek, 5);
  assert.deepEqual(sim.reported, []);
});

test('时序复演：箭头从第 5 周跳到第 10 周，中途经过的页都不算用户选择', () => {
  const sim = new PagerSim(5, 20);
  sim.goTo(10, [4, 5, 6, 7, 8, 9]);

  assert.equal(sim.selectedWeek, 10);
  assert.deepEqual(sim.reported, []);
});

test('时序复演：程序化跳走后用户再滑，正常上报', () => {
  const sim = new PagerSim(5, 20);
  sim.goTo(10, [4, 5, 6, 7, 8, 9]);
  sim.onChange(10); // 用户滑到第 11 周
  assert.deepEqual(sim.reported, [11]);
  assert.equal(sim.selectedWeek, 11);
});

test('时序复演："回到本周"之后再滑回同一页，仍然能被上报（不能长期记住）', () => {
  const sim = new PagerSim(5, 20);
  sim.onChange(7); // 用户滑到第 8 周
  sim.goTo(5, [7, 6, 5]); // 回到本周（第 5 周）
  assert.deepEqual(sim.reported, [8]);

  // 用户又滑到第 6 周：不能因为"刚才程序翻过第 6 周"就被永久忽略
  sim.onChange(5);
  assert.deepEqual(sim.reported, [8, 6]);
});

test('时序复演：连续用户滑动每次都上报', () => {
  const sim = new PagerSim(3, 20);
  sim.onChange(3);
  sim.onChange(4);
  sim.onChange(5);
  assert.deepEqual(sim.reported, [4, 5, 6]);
});

test('时序复演：学期末边界，跳到超出总周数的目标会被夹住', () => {
  const sim = new PagerSim(20, 20);
  sim.goTo(25, [19]);
  assert.equal(sim.selectedWeek, 20);
  assert.deepEqual(sim.reported, []);
});
