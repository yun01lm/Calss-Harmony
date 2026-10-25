/**
 * 自定义安排表单的断言（`logic/EventDraft.ts`）。
 *
 * 这里测的是**用户输入这一侧**：能自动纠正的（全角、`~`、「周」字、起止填反、越界）
 * 一律纠正后放行并在输入框回显；纠正不了的才报错，且第一句错误必须是"最该先修的"。
 *
 * 与课程表单共享的边界（周次 53 周上限、`WeekMasks` 语义）在这里也钉一遍：
 * 两个表单的输入侧规则一旦不一致，用户就会遇到"课程能存、安排不能存"这种怪事。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { Colors } from '../entry/src/main/ets/logic/Colors.ts';
import { EventDraft } from '../entry/src/main/ets/logic/EventDraft.ts';
import type { EventDraftResult } from '../entry/src/main/ets/logic/EventDraft.ts';
import { WeekItems } from '../entry/src/main/ets/logic/WeekItems.ts';
import type { WeekItem } from '../entry/src/main/ets/logic/WeekItems.ts';

// ---------------------------------------------------------------- 工具

const WEEKS_1_TO_16 = 65535; // (1 << 16) - 1

function check(
  title: string,
  weeks: string,
  day = 3,
  start = 3,
  end = 4,
  periodCount = 12
): EventDraftResult {
  return EventDraft.check(EventDraft.input(title, '', day, start, end, weeks), periodCount);
}

// ---------------------------------------------------------------- 正常路径

test('标题 + 周次 → 掩码与时间都原样带出', () => {
  const r: EventDraftResult = check('健身', '1-16');
  assert.equal(r.error, '');
  assert.equal(r.title, '健身');
  assert.equal(r.day, 3);
  assert.equal(r.start, 3);
  assert.equal(r.end, 4);
  assert.equal(r.weeks, '1-16');
  assert.equal(Number(r.weekMask), WEEKS_1_TO_16);
});

test('单节安排合法（第 3 节 ~ 第 3 节）', () => {
  const r: EventDraftResult = check('交作业', '1-16', 5, 3, 3);
  assert.equal(r.error, '');
  assert.equal(r.start, 3);
  assert.equal(r.end, 3);
});

test('标题与备注两端空白被去掉', () => {
  const r: EventDraftResult = EventDraft.check(
    EventDraft.input('  自习  ', '  图书馆四楼  ', 2, 1, 2, '1-8'), 12
  );
  assert.equal(r.title, '自习');
  assert.equal(r.note, '图书馆四楼');
});

// ---------------------------------------------------------------- 自动纠正

test('起止节填反自动对调', () => {
  const r: EventDraftResult = check('健身', '1-16', 3, 7, 2);
  assert.equal(r.error, '');
  assert.equal(r.start, 2);
  assert.equal(r.end, 7);
});

test('全角周次与「1~8周」被纠正，并把规范写法回填', () => {
  const a: EventDraftResult = check('健身', '１－１６');
  assert.equal(a.error, '');
  assert.equal(a.weeks, '1-16');
  assert.equal(Number(a.weekMask), WEEKS_1_TO_16);

  const b: EventDraftResult = check('健身', '1~8周');
  assert.equal(b.error, '');
  assert.equal(b.weeks, '1-8');
  assert.equal(Number(b.weekMask), 255);
});

test('单双周写法保住单周', () => {
  const r: EventDraftResult = check('答疑', '1-15周(单)');
  assert.equal(r.error, '');
  assert.equal(r.weeks, '1-15单');
  assert.equal(Number(r.weekMask), 21845); // 0b0101_0101_0101_0101
});

test('星期与节次越界被夹住（不报错，否则表单改不动）', () => {
  const r: EventDraftResult = check('越界', '1-16', 9, 99, 0, 12);
  assert.equal(r.error, '');
  assert.equal(r.day, 7);
  assert.equal(r.start, 1);
  assert.equal(r.end, 12);
});

// ---------------------------------------------------------------- 报错

test('标题为空时报错，且不被"周次不对"抢在前面', () => {
  const r: EventDraftResult = check('   ', '乱写');
  assert.equal(r.error, '请输入标题（如：健身 / 自习）');
  assert.equal(r.badField, EventDraft.BAD_TITLE);
  assert.equal(r.weekMask, 0n);
});

test('周次认不出 → 报错并给出格式提示，原文留着给用户改', () => {
  const r: EventDraftResult = check('健身', '待定');
  assert.ok(r.error.startsWith('周次没填对'));
  assert.ok(r.error.includes('1-20'));
  assert.equal(r.badField, EventDraft.BAD_WEEKS);
  assert.equal(r.weeks, '待定');
  assert.equal(r.weekMask, 0n);
});

test('"第1-3周" 这种未知写法被挡下（不静默变成只剩第 3 周）', () => {
  const r: EventDraftResult = check('健身', '第1-3周');
  assert.ok(r.error.length > 0);
  assert.equal(r.weekMask, 0n);
});

test('周次超过 53 周被挡在输入侧（否则写库时才抛错）', () => {
  const ok: EventDraftResult = check('健身', '1-53');
  assert.equal(ok.error, '');

  const tooFar: EventDraftResult = check('健身', '1-64');
  assert.ok(tooFar.error.includes('可保存范围'));
  assert.equal(tooFar.weekMask, 0n);
});

test('报错时也回填规范化后的时间与周次', () => {
  const r: EventDraftResult = check('  ', '１－８', 2, 5, 3);
  assert.ok(r.error.length > 0);
  assert.equal(r.day, 2);
  assert.equal(r.start, 3);
  assert.equal(r.end, 5);
  assert.equal(r.weeks, '1-8');
});

// ---------------------------------------------------------------- 默认值

test('新建默认：整学期周次、该格星期/节次、止节顺延', () => {
  const input = EventDraft.newInput(3, 5, 12, 20);
  assert.equal(input.title, '');
  assert.equal(input.day, 3);
  assert.equal(input.start, 5);
  assert.equal(input.end, 6);
  assert.equal(input.weeks, '1-20');
});

test('最后一节新建时止节不越界', () => {
  const input = EventDraft.newInput(1, 12, 12, 20);
  assert.equal(input.start, 12);
  assert.equal(input.end, 12);
});

test('defaultWeeks 覆盖整学期；非法总周数退回 16 周而不是空掩码', () => {
  assert.equal(EventDraft.defaultWeeks(20), '1-20');
  assert.equal(EventDraft.defaultWeeks(1), '1');
  assert.equal(EventDraft.defaultWeeks(0), '1-16');
  assert.equal(EventDraft.defaultWeeks(-3), '1-16');
  assert.equal(EventDraft.defaultWeeks(Number.NaN), '1-16');
  assert.equal(EventDraft.defaultWeeks(99), '1-16');
});

// ---------------------------------------------------------------- 显示

test('periodText：单节不写成"第 3-3 节"', () => {
  assert.equal(EventDraft.periodText(3, 3, 4), '周三 第 3-4 节');
  assert.equal(EventDraft.periodText(3, 3, 3), '周三 第 3 节');
  assert.equal(EventDraft.periodText(7, 1, 2), '周日 第 1-2 节');
});

// ---------------------------------------------------------------- 与网格的接线

test('表单产出的掩码直接喂给网格：5-6 周只出现在第 5、6 周', () => {
  const r: EventDraftResult = EventDraft.check(EventDraft.input('社团', '', 6, 3, 4, '5-6'), 12);
  assert.equal(r.error, '');

  const weeks: WeekItem[][] = WeekItems.build({
    courses: [],
    schedules: [],
    events: [
      {
        id: 1,
        title: r.title,
        dayOfWeek: r.day,
        startPeriod: r.start,
        endPeriod: r.end,
        weekMask: Number(r.weekMask),
        color: 0,
        note: r.note,
      },
    ],
    totalWeeks: 8,
  });

  assert.equal(weeks.length, 8);
  for (let w = 1; w <= 8; w++) {
    const expected: number = w === 5 || w === 6 ? 1 : 0;
    assert.equal(weeks[w - 1].length, expected, '第 ' + w + ' 周');
  }
  // 颜色走默认安排色（color === 0 时），与 Android 的 EVENT_COLOR 一致
  assert.equal(weeks[4][0].color, Colors.EVENT_COLOR);
  assert.equal(weeks[4][0].kind, WeekItems.KIND_EVENT);
  assert.equal(weeks[4][0].subtitle, '');
});
